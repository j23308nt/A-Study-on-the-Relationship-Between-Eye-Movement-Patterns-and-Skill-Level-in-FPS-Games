"""Windows recorder: native camera processing continues while Aim Lab has focus."""
from collections import deque
from pathlib import Path
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import importlib.metadata
import json
import math
import os
import queue
import sys
import threading
import time
import urllib.request

from aimlab_core import Calibration, Recording, Smoother, extract_features, utc_now

ROOT = Path(__file__).resolve().parent
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
MODEL_SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"


def model_file():
    destination = ROOT / ".aimlab-models" / "face_landmarker.task"
    if not destination.exists():
        destination.parent.mkdir(exist_ok=True)
        temporary = destination.with_suffix(".download")
        try:
            with urllib.request.urlopen(MODEL_URL, timeout=60) as response, temporary.open("wb") as output:
                while block := response.read(1024 * 1024):
                    output.write(block)
            # The official model is a task ZIP bundle, not an HTML error page.
            if temporary.stat().st_size < 1024 * 1024:
                raise RuntimeError("モデルのダウンロードが不完全です。")
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != MODEL_SHA256:
                raise RuntimeError("モデルのSHA-256が一致しません。ダウンロードをやり直してください。")
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
    if hashlib.sha256(destination.read_bytes()).hexdigest() != MODEL_SHA256:
        raise RuntimeError("保存済みモデルが不正です。.aimlab-models内のface_landmarker.taskを削除して再起動してください。")
    return destination


def create_detector(path):
    import mediapipe as mp
    options = mp.tasks.vision.FaceLandmarkerOptions(
        # Buffer avoids native filename encoding issues in Japanese workspace paths.
        base_options=mp.tasks.BaseOptions(model_asset_buffer=path.read_bytes()),
        running_mode=mp.tasks.vision.RunningMode.VIDEO, num_faces=1)
    return mp.tasks.vision.FaceLandmarker.create_from_options(options)


class WindowsControls:
    def __init__(self):
        if sys.platform != "win32":
            raise RuntimeError("Aim Labの視線記録はWindows用です。")
        self.user = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.user.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        self.user.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        self.user.GetForegroundWindow.restype = wintypes.HWND
        self.user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.user.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
        self.user.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
        self.user.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
        self.registered = []
        self.hotkeys = queue.SimpleQueue()
        self.hotkey_quit = threading.Event()
        self.hotkey_thread = None

    def size(self):
        return self.user.GetSystemMetrics(0), self.user.GetSystemMetrics(1)

    def foreground(self):
        pid = wintypes.DWORD()
        self.user.GetWindowThreadProcessId(self.user.GetForegroundWindow(), ctypes.byref(pid))
        process = self.kernel.OpenProcess(0x1000, False, pid.value)
        if not process:
            return "unknown"
        try:
            buffer, length = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
            if self.kernel.QueryFullProcessImageNameW(process, 0, buffer, ctypes.byref(length)):
                return Path(buffer.value).name
            return "unknown"
        finally:
            self.kernel.CloseHandle(process)

    def register(self):
        # Tk consumes messages on its own UI thread. Give global hotkeys their
        # own Windows message queue so WM_HOTKEY cannot be swallowed by Tk.
        ready, errors = threading.Event(), []

        def loop():
            try:
                for ident, key in [(1, 0x77), (2, 0x78), (3, 0x79)]:
                    if not self.user.RegisterHotKey(None, ident, 0x4000, key):
                        raise RuntimeError("F8・F9・F10が他のアプリで使用中です。別の記録アプリを終了してください。")
                    self.registered.append(ident)
                ready.set()
                message = wintypes.MSG()
                while not self.hotkey_quit.is_set():
                    while self.user.PeekMessageW(ctypes.byref(message), None, 0x312, 0x312, 1):
                        self.hotkeys.put(message.wParam)
                    self.hotkey_quit.wait(.015)
            except Exception as error:
                errors.append(error)
            finally:
                ready.set()
                for ident in self.registered:
                    self.user.UnregisterHotKey(None, ident)
                self.registered.clear()

        self.hotkey_thread = threading.Thread(target=loop, daemon=True)
        self.hotkey_thread.start()
        if not ready.wait(3):
            self.close()
            raise RuntimeError("グローバルキーを準備できませんでした。")
        if errors:
            self.close()
            raise errors[0]

    def messages(self):
        while not self.hotkeys.empty():
            yield self.hotkeys.get()

    def close(self):
        self.hotkey_quit.set()
        if self.hotkey_thread:
            self.hotkey_thread.join(timeout=1)


class CameraWorker:
    def __init__(self, camera, width, height, backend="auto"):
        self.camera, self.width, self.height = camera, width, height
        self.backend = backend
        self.stage = "ライブラリを読み込み中です。"
        self.started = time.perf_counter()
        self.last_frame_at = None
        self.lock = threading.RLock()
        self.history = deque(maxlen=30)
        self.errors = queue.SimpleQueue()
        self.quit = threading.Event()
        self.ready = False
        self.model = None
        self.recording = None
        self.smoother = Smoother()
        self.details = {}
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def loop(self):
        capture = None
        try:
            import cv2
            import mediapipe as mp
            self.stage = "顔検出モデルを準備中です。初回はダウンロードします。"
            model_path = model_file()
            self.stage = "顔検出モデルを起動中です。"
            with create_detector(model_path) as detector:
                capture, first_image, backend = self.open_camera(cv2)
                self.stage = "カメラ映像の顔・虹彩検出を確認中です。"
                self.details = {"camera_index": self.camera, "camera_backend": backend,
                                "camera_width": first_image.shape[1], "camera_height": first_image.shape[0], "model_url": MODEL_URL,
                                "model_sha256": hashlib.sha256(model_path.read_bytes()).hexdigest(),
                                "packages": {name: importlib.metadata.version(name) for name in ("mediapipe", "numpy", "opencv-contrib-python")}}
                failures, timestamp = 0, -1
                pending_image = first_image
                while not self.quit.is_set():
                    start = time.perf_counter()
                    if pending_image is not None:
                        ok, image = True, pending_image
                        pending_image = None
                    else:
                        ok, image = capture.read()
                    timestamp = max(timestamp + 1, int(start * 1000))
                    if ok:
                        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
                        result = detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp)
                        features = extract_features(result.face_landmarks[0]) if result.face_landmarks else None
                        reason, failures = "face_not_detected" if features is None else "", 0
                    else:
                        features, reason = None, "camera_read_failed"
                        failures += 1
                    end = time.perf_counter()
                    self.accept_frame(start, end, features, reason)
                    if ok:
                        self.ready = True
                        self.last_frame_at = end
                        self.stage = "カメラの準備ができました。"
                    if failures >= 20:
                        raise RuntimeError("カメラ映像が途切れました。途中までの記録を保存しました。")
                    if not ok:
                        self.quit.wait(.05)
        except Exception as error:
            with self.lock:
                self.ready = False
                if self.recording:
                    try:
                        self.recording.finish("camera_or_processing_error")
                    except Exception as save_error:
                        self.errors.put(f"保存エラー：{save_error}。CSVとsession.jsonの状態を確認してください。")
                    else:
                        self.recording = None
            self.stage = f"カメラの準備に失敗しました：{error}"
            self.errors.put(str(error))
        finally:
            self.ready = False
            if capture is not None:
                capture.release()

    def open_camera(self, cv):
        # Try a real frame before enabling calibration. Keep the driver's
        # default resolution: forcing 1280x720 can stall format negotiation.
        choices = [("MSMF", cv.CAP_MSMF), ("DirectShow", cv.CAP_DSHOW)]
        if self.backend != "auto":
            choices = [choice for choice in choices if choice[0] == self.backend]
        if not choices:
            raise ValueError("カメラ接続方式が不正です。")
        for label, backend in choices:
            if self.quit.is_set():
                raise RuntimeError("カメラの準備を中止しました。")
            self.stage = f"カメラ{self.camera}に{label}で接続中です。"
            candidate = cv.VideoCapture(self.camera, backend)
            try:
                if candidate.isOpened():
                    self.stage = f"カメラ{self.camera}の映像を{label}で確認中です。"
                    ok, image = candidate.read()
                    if ok and image is not None and len(image.shape) >= 2 and image.shape[0] and image.shape[1]:
                        return candidate, image, label
            except Exception:
                candidate.release()
                raise
            candidate.release()
        raise RuntimeError("カメラ映像を取得できません。ブラウザ等のカメラを停止し、カメラ番号を変更して再接続してください。Windowsのカメラ許可も確認してください。")

    def accept_frame(self, start, end, features, reason=""):
        with self.lock:
            if features is not None:
                self.history.append((start, list(features)))
            else:
                self.history.clear()
                self.smoother = Smoother()
            if self.recording:
                if start < self.recording.started:
                    return
                raw = self.model.predict(features, self.width, self.height) if features is not None and self.model else None
                point = None
                if raw and all(math.isfinite(v) for v in raw):
                    point = self.smoother.apply(max(0, min(self.width - 1, raw[0])),
                                                max(0, min(self.height - 1, raw[1])), start)
                self.recording.frame(start, end, raw, point, reason)


class RecorderApp:
    def __init__(self, camera):
        import tkinter as tk
        from tkinter import ttk
        self.tk, self.ttk = tk, ttk
        self.controls = WindowsControls()
        self.width, self.height = self.controls.size()
        self.root = tk.Tk()
        self.root.title("Aim Lab 視線記録")
        self.root.geometry(f"680x{min(860, max(600, self.height - 160))}+60+60")
        self.status = tk.StringVar(value="カメラ・モデルの準備中です。初回はモデルをダウンロードします。")
        self.values = {}
        frame = ttk.Frame(self.root, padding=20)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="Aim Lab 実行中の視線記録", font=("Yu Gothic UI", 18)).pack(anchor="w")
        self.status_label = ttk.Label(frame, textvariable=self.status, wraplength=620, foreground="#075b57")
        self.status_label.pack(anchor="w", fill="x", pady=10)
        camera_row = ttk.Frame(frame)
        camera_row.pack(fill="x", pady=4)
        ttk.Label(camera_row, text="カメラ番号").pack(side="left")
        self.camera_number = tk.StringVar(value=str(camera))
        ttk.Combobox(camera_row, textvariable=self.camera_number, values=[str(i) for i in range(6)], width=4, state="readonly").pack(side="left", padx=5)
        self.camera_backend = tk.StringVar(value="auto")
        ttk.Combobox(camera_row, textvariable=self.camera_backend, values=["auto", "MSMF", "DirectShow"], width=12, state="readonly").pack(side="left", padx=5)
        self.retry_camera_button = ttk.Button(camera_row, text="カメラを再接続", command=self.retry_camera)
        self.retry_camera_button.pack(side="left", padx=5)
        ttk.Label(frame, text="プライマリ画面で校正し、Aim Labも同じ画面・解像度で実行します。\nブラウザのカメラは停止してから使ってください。", wraplength=600).pack(anchor="w", pady=10)
        fields = [("participant_id", "参加者ID", "P01"), ("session_number", "セッション番号", "1"),
                  ("task_name", "Aim Lab タスク名・モード", ""), ("sensitivity", "ゲーム内感度・FOV", ""),
                  ("mouse_dpi", "マウスDPI（任意）", ""), ("viewing_distance_cm", "観察距離 (cm)", "30"),
                  ("notes", "照明・視力矯正・その他の条件", "")]
        for key, label, default in fields:
            row = ttk.Frame(frame)
            row.pack(fill="x", pady=3)
            ttk.Label(row, text=label, width=26).pack(side="left")
            variable = tk.StringVar(value=default)
            self.values[key] = variable
            ttk.Entry(row, textvariable=variable).pack(side="left", fill="x", expand=True)
        row = ttk.Frame(frame)
        row.pack(fill="x", pady=5)
        ttk.Label(row, text="頭部条件", width=26).pack(side="left")
        self.head = tk.StringVar(value="固定しない")
        ttk.Combobox(row, textvariable=self.head, values=["固定する", "固定しない"], state="readonly").pack(side="left")
        self.confirmed = tk.BooleanVar(value=False)
        ttk.Checkbutton(frame, text="頭部条件・距離を準備し、校正から課題終了まで維持します", variable=self.confirmed).pack(anchor="w", pady=8)
        self.calibrate_button = ttk.Button(frame, text="1. 全画面で9点校正", command=self.calibrate)
        self.calibrate_button.pack(fill="x", pady=4)
        ttk.Label(frame, text="2. 校正後、Aim Labに切り替えてF8で記録開始\n3. タスク終了時にF9で停止・保存（F10：任意の時刻の目印）", wraplength=600).pack(anchor="w", pady=8)
        self.stop_button = ttk.Button(frame, text="停止・保存（F9）", command=self.stop)
        self.stop_button.pack(fill="x")
        ttk.Button(frame, text="保存フォルダを開く", command=self.open_folder).pack(fill="x", pady=4)
        self.worker = CameraWorker(camera, self.width, self.height)
        self.calibration_window = None
        self.calibration_data = None
        self.prepared = None
        self.last_path = None
        self.last_foreground = None
        self.last_monitor_check = 0
        self.camera_announced = False
        self.camera_error = None
        self.last_camera_stage = None
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        try:
            self.controls.register()
        except Exception:
            self.root.destroy()
            raise
        self.worker.thread.start()
        self.root.after(50, self.poll)

    def retry_camera(self):
        if self.worker.recording or self.calibration_window:
            self.status.set("課題の記録・校正を終了してからカメラを再接続してください。")
            return
        if not self.worker.quit.is_set():
            self.retry_started = time.perf_counter()
            self.worker.quit.set()
            self.worker.model = None
            self.camera_announced = False
            self.camera_error = None
            self.status.set("カメラを停止して再接続しています。")
        if self.worker.thread.is_alive():
            if time.perf_counter() - self.retry_started > 5:
                self.status.set("カメラドライバーの応答を待っています。アプリを閉じて再起動し、接続方式を変更してください。")
                return
            if not hasattr(self, "retry_started"):
                self.retry_started = time.perf_counter()
            self.root.after(100, self.retry_camera)
            return
        self.retry_started = time.perf_counter()
        self.worker = CameraWorker(int(self.camera_number.get()), self.width, self.height, self.camera_backend.get())
        self.camera_error, self.last_camera_stage = None, None
        self.worker.thread.start()

    def metadata(self):
        data = {key: value.get().strip() for key, value in self.values.items()}
        if not data["participant_id"] or not data["task_name"] or not self.confirmed.get():
            raise ValueError("参加者ID・タスク名を入力し、実施条件の確認にチェックしてください。")
        if any(len(value) > 1500 for value in data.values()):
            raise ValueError("入力は各欄1500文字以内にしてください。")
        data["session_number"] = int(data["session_number"])
        data["viewing_distance_cm"] = float(data["viewing_distance_cm"])
        if data["session_number"] < 1 or not 5 <= data["viewing_distance_cm"] <= 200:
            raise ValueError("セッション番号は1以上、観察距離は5〜200cmで入力してください。")
        if data["mouse_dpi"] and (not data["mouse_dpi"].isdigit() or int(data["mouse_dpi"]) < 1):
            raise ValueError("マウスDPIは正の整数または空欄にしてください。")
        data.update(head_condition="fixed" if self.head.get() == "固定する" else "free",
                    screen_width=self.width, screen_height=self.height, five_point_correction_applied=False,
                    code_sha256={name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in ("aimlab.py", "aimlab_core.py")})
        return data

    def calibrate(self):
        if not self.worker.ready or self.worker.quit.is_set() or self.worker.recording or self.calibration_window:
            self.status.set("カメラの準備と記録停止を確認してください。")
            return
        try:
            if self.controls.size() != (self.width, self.height):
                raise ValueError("画面サイズが変わりました。記録アプリを再起動してください。")
            self.prepared = self.metadata()
        except (ValueError, OSError) as error:
            self.status.set(str(error))
            return
        self.worker.model = None
        self.calibration_data = {"features": [], "targets": [], "samples": []}
        self.point_index, self.clicks = 0, 0
        self.points = [(x, y) for y in (.1, .5, .9) for x in (.08, .5, .92)]
        self.points = [self.points[i] for i in (0, 1, 2, 3, 5, 6, 7, 8, 4)]
        self.root.withdraw()
        self.calibration_window = self.tk.Toplevel(self.root)
        self.calibration_window.geometry(f"{self.width}x{self.height}+0+0")
        self.calibration_window.attributes("-fullscreen", True)
        self.canvas = self.tk.Canvas(self.calibration_window, bg="#111827", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Button-1>", self.capture_point)
        self.calibration_window.bind("<Escape>", lambda event: self.end_calibration(False))
        self.calibration_window.bind("<FocusOut>", self.calibration_focus_out)
        self.calibration_window.protocol("WM_DELETE_WINDOW", lambda: self.end_calibration(False))
        self.calibration_window.focus_force()
        self.draw_point()

    def calibration_focus_out(self, event):
        if event.widget == self.calibration_window:
            self.end_calibration(False)

    def draw_point(self):
        self.canvas.delete("all")
        x, y = self.points[self.point_index]
        x, y = round(x * self.width), round(y * self.height)
        self.canvas.create_oval(x - 18, y - 18, x + 18, y + 18, fill="#22d3ee", outline="white")
        self.canvas.create_line(x - 5, y, x + 5, y, fill="black")
        self.canvas.create_line(x, y - 5, x, y + 5, fill="black")
        self.caption = self.canvas.create_text(self.width / 2, 45, text=f"{self.point_index + 1}/9：点を見ながら5回クリック（{self.clicks}/5）　Escで中止", fill="white", font=("Yu Gothic UI", 16))
        self.target_shown = time.perf_counter()
        self.last_click = self.target_shown

    def capture_point(self, event):
        now = time.perf_counter()
        x, y = self.points[self.point_index]
        if math.hypot(event.x - x * self.width, event.y - y * self.height) > 45:
            return
        with self.worker.lock:
            recent = [features for stamp, features in self.worker.history if stamp >= max(self.target_shown + .8, self.last_click, now - .4)]
        if len(recent) < 3:
            self.canvas.itemconfigure(self.caption, text="点を見たまま少し待って、再度クリックしてください。顔・両目をカメラに映してください。")
            return
        average = [sum(v[i] for v in recent) / len(recent) for i in range(12)]
        self.calibration_data["features"].append(average)
        self.calibration_data["targets"].append([x, y])
        self.calibration_data["samples"].append({"target_normalized": [x, y], "features": average, "frames_averaged": len(recent)})
        self.last_click = now
        self.clicks += 1
        if self.clicks == 5:
            self.point_index += 1
            self.clicks = 0
            if self.point_index == 9:
                self.end_calibration(True)
                return
            self.draw_point()
        else:
            self.canvas.itemconfigure(self.caption, text=f"{self.point_index + 1}/9：点を見ながら5回クリック（{self.clicks}/5）　Escで中止")

    def end_calibration(self, success):
        if not self.calibration_window:
            return
        self.calibration_window.destroy()
        self.calibration_window = None
        self.root.deiconify()
        if success:
            try:
                model = Calibration(self.calibration_data["features"], self.calibration_data["targets"])
                self.prepared["calibration"] = model.snapshot()
                self.prepared["calibration_samples"] = self.calibration_data["samples"]
                self.prepared["calibrated_at"] = utc_now()
                with self.worker.lock:
                    self.worker.model = model
                    self.worker.smoother = Smoother()
                self.status.set("校正完了。Aim Labを同じ画面で開き、F8で記録開始してください。F9で保存します。")
            except Exception as error:
                self.worker.model = None
                self.status.set(f"校正に失敗しました：{error}")
        else:
            self.worker.model = None
            self.status.set("校正を中止しました。9点校正をやり直してください。")

    def start(self):
        with self.worker.lock:
            if self.worker.recording:
                return
            if not self.worker.ready or self.worker.model is None or self.calibration_window:
                self.status.set("先に全画面で9点校正してください。")
                return
            if self.controls.size() != (self.width, self.height):
                self.worker.model = None
                self.status.set("画面サイズが変わりました。アプリを再起動し、再校正してください。")
                return
            try:
                self.worker.smoother = Smoother()
                self.worker.recording = Recording(ROOT / "recordings" / "aimlab", dict(self.prepared, **self.worker.details))
                self.worker.recording.event("foreground_at_start", self.controls.foreground())
                self.last_path = self.worker.recording.path
                self.last_foreground = None
                self.root.iconify()
                self.status.set("記録中です。Aim Lab終了時はF9で停止・保存します。")
            except Exception as error:
                self.status.set(f"記録を開始できません：{error}")

    def stop(self, reason="manual_stop"):
        with self.worker.lock:
            if not self.worker.recording:
                return
            try:
                recording = self.worker.recording
                self.last_path = recording.finish(reason, self.controls.foreground())
                self.worker.recording = None
                self.status.set(f"保存済み：{self.last_path}\n有効視線 {recording.valid} / 処理フレーム {recording.processed}。次の記録は9点校正から準備してください。")
                self.worker.model = None
                self.root.deiconify()
            except Exception as error:
                self.status.set(f"保存に失敗しました：{error}。保存フォルダのCSVを確認してください。")
                self.root.deiconify()

    def poll(self):
        if self.worker.ready and not self.worker.quit.is_set() and not self.camera_announced:
            self.camera_announced = True
            self.status.set("カメラの準備ができました。実施条件を入力して9点校正を開始してください。")
        for ident in self.controls.messages():
            if ident == 1:
                self.start()
            elif ident == 2:
                self.stop()
            elif ident == 3:
                with self.worker.lock:
                    if self.worker.recording:
                        self.worker.recording.event("manual_marker", self.controls.foreground())
        now = time.perf_counter()
        if now - self.last_monitor_check >= 1:
            self.last_monitor_check = now
            if self.controls.size() != (self.width, self.height):
                self.stop("screen_size_changed")
                self.worker.model = None
                self.status.set("画面サイズが変わりました。記録アプリを再起動してください。")
            with self.worker.lock:
                recording = self.worker.recording
                if recording:
                    foreground = self.controls.foreground()
                    if foreground != self.last_foreground:
                        recording.event("foreground_changed", foreground)
                        self.last_foreground = foreground
                    self.status.set(f"記録中：有効視線 {recording.valid} / 処理 {recording.processed} フレーム。F9で保存。")
        while not self.worker.errors.empty():
            self.camera_error = self.worker.errors.get()
            self.status.set(f"エラー：{self.camera_error}")
            self.root.deiconify()
        if not self.worker.ready and not self.camera_error and not self.worker.quit.is_set():
            elapsed = time.perf_counter() - self.worker.started
            stage = self.worker.stage
            if elapsed > 15:
                stage += "\n時間がかかっています。ほかのカメラ使用アプリを停止してください。接続が続かない場合はカメラ番号・方式を変えて再接続してください。"
            if stage != self.last_camera_stage:
                self.status.set(stage)
                self.last_camera_stage = stage
        self.calibrate_button.configure(state="normal" if self.worker.ready and not self.worker.quit.is_set() and not self.worker.recording else "disabled")
        self.stop_button.configure(state="normal" if self.worker.recording else "disabled")
        self.root.after(50, self.poll)

    def open_folder(self):
        folder = self.last_path or ROOT / "recordings" / "aimlab"
        folder.mkdir(parents=True, exist_ok=True)
        os.startfile(folder)

    def close(self):
        self.stop("application_closed")
        if self.worker.recording:
            return  # Keep the app open if finalization failed; allow a save retry.
        self.worker.quit.set()
        self.controls.close()
        self.root.destroy()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--check", action="store_true", help="Check imports and model; do not open a camera")
    args = parser.parse_args()
    if args.check:
        import cv2
        import mediapipe
        path = model_file()
        with create_detector(path):
            print(json.dumps({"ok": True, "mediapipe": mediapipe.__version__, "opencv": cv2.__version__,
                              "model_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}))
        return
    app = RecorderApp(args.camera)
    app.root.mainloop()
    app.worker.thread.join(timeout=3)


if __name__ == "__main__":
    main()
