import csv
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import aimlab
from aimlab_core import Calibration, Recording, Smoother, extract_features


def rows(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


class StorageTests(unittest.TestCase):
    def test_streaming_failures_gaps_events_and_idempotent_finish(self):
        with tempfile.TemporaryDirectory() as folder:
            clock = Mock(return_value=10)
            recording = Recording(folder, {"screen_width": 1920, "screen_height": 1080}, clock)
            recording.frame(9, 10, (1, 1), (1, 1))  # In-flight frame before F8.
            recording.frame(10.01, 10.02, (100, 200), (100, 200))
            recording.frame(10.04, 10.05, reason="face_not_detected")
            recording.frame(10.07, 10.08, (500, 300), (500, 300))
            recording.frame(10.1, 10.11, (510, 300), (510, 300))
            recording.frame(10.7, 10.71, (700, 400), (700, 400))
            recording.frame(10.8, 10.81, (float("nan"), 200), (1, 2))
            # Rows are available before finalization. Failed frames have blanks, never (0, 0).
            samples = rows(recording.path / "samples.csv")
            self.assertEqual(len(samples), 6)
            self.assertEqual(samples[1]["valid"], "0")
            self.assertEqual(samples[1]["x"], "")
            self.assertEqual(samples[-1]["failure_reason"], "nonfinite_prediction")
            gaze = rows(recording.path / "gaze.csv")
            self.assertEqual(len(gaze), 4)
            self.assertEqual(gaze[1]["distance_px"], "0.0")
            self.assertAlmostEqual(float(gaze[2]["speed_px_per_second"]), 333.333, places=3)
            self.assertEqual(gaze[3]["delta_time_ms"], "0")
            clock.return_value = 11
            recording.event("manual_marker", "AimLab.exe")
            path = recording.finish("screen_size_changed", "AimLab.exe")
            original = (path / "session.json").read_bytes()
            self.assertEqual(recording.finish(), path)
            self.assertEqual((path / "session.json").read_bytes(), original)
            recording.frame(11, 11.1, (1, 2), (1, 2))
            self.assertEqual(len(rows(path / "samples.csv")), 6)
            session = json.loads(original)
            self.assertEqual(session["summary"]["status"], "stopped")
            self.assertEqual(session["summary"]["stop_reason"], "screen_size_changed")
            self.assertEqual(session["summary"]["invalid_frames"], 2)
            self.assertEqual(session["summary"]["max_processed_gap_ms"], 600)
            self.assertEqual([r["event"] for r in rows(path / "events.csv")], ["recording_start", "manual_marker", "recording_stop"])
            second = Recording(folder, {"screen_width": 1920, "screen_height": 1080}, clock)
            self.assertNotEqual(path, second.path)
            second.finish()


class EstimationTests(unittest.TestCase):
    def test_native_calibration_maps_to_physical_monitor_and_smoothing_resets(self):
        try:
            import numpy
        except ImportError:
            self.skipTest("numpy not installed")
        features, targets = [], []
        for y in (.1, .5, .9):
            for x in (.08, .5, .92):
                for _ in range(5):
                    features.append([1, x, y, x, y, x, y, .5, .5, .6, 0, 0])
                    targets.append([x, y])
        model = Calibration(features, targets)
        point = model.predict([1, .08, .9, .08, .9, .08, .9, .5, .5, .6, 0, 0], 1920, 1080)
        self.assertLess(abs(point[0] - 153.6), 2)
        self.assertLess(abs(point[1] - 972), 2)
        json.dumps(model.snapshot(), allow_nan=False)
        smoother = Smoother()
        self.assertEqual(smoother.apply(100, 200, 1), (100, 200))
        self.assertLess(smoother.apply(1000, 800, 1.03)[0], 200)
        self.assertEqual(smoother.apply(1000, 800, 2), (1000, 800))

    def test_landmark_feature_geometry_and_missing_iris(self):
        points = [SimpleNamespace(x=.5, y=.5) for _ in range(478)]
        for index, x, y in [(10, .5, .2), (152, .5, .8), (1, .5, .5), (33, .25, .4),
                            (133, .45, .4), (159, .35, .36), (145, .35, .44),
                            (362, .55, .4), (263, .75, .4), (386, .65, .36), (374, .65, .44)]:
            points[index] = SimpleNamespace(x=x, y=y)
        for index in range(468, 478):
            points[index] = SimpleNamespace(x=.35 if index < 473 else .65, y=.4)
        features = extract_features(points)
        self.assertEqual(len(features), 12)
        self.assertAlmostEqual(features[1], 0)
        self.assertAlmostEqual(features[2], 0)
        self.assertAlmostEqual(features[9], .6)
        self.assertIsNone(extract_features(points[:468]))


class BackgroundTests(unittest.TestCase):
    def test_camera_loop_writes_without_ui_callbacks_or_foreground_focus(self):
        with tempfile.TemporaryDirectory() as folder:
            worker = aimlab.CameraWorker(0, 1920, 1080)
            worker.model = Mock(predict=Mock(return_value=(100, 200)))
            worker.recording = Recording(folder, {"screen_width": 1920, "screen_height": 1080})
            detector = Mock()
            detector.__enter__ = Mock(return_value=detector)
            detector.__exit__ = Mock(return_value=False)
            count = [0]

            def detect(_image, _stamp):
                count[0] += 1
                if count[0] == 20:
                    worker.quit.set()
                return SimpleNamespace(face_landmarks=[] if count[0] % 5 == 0 else [[1]])

            detector.detect_for_video = detect
            capture = Mock()
            capture.isOpened.return_value = True
            image = SimpleNamespace(shape=(720, 1280, 3))
            capture.read.return_value = (True, image)
            capture.get.return_value = 1280
            cv = SimpleNamespace(VideoCapture=lambda *_: capture, CAP_DSHOW=1, CAP_MSMF=2, CAP_PROP_FRAME_WIDTH=3,
                                 CAP_PROP_FRAME_HEIGHT=4, COLOR_BGR2RGB=1, cvtColor=lambda image, *_: image)
            mp = SimpleNamespace(Image=lambda **_: object(), ImageFormat=SimpleNamespace(SRGB=1))
            asset = Path(folder) / "model.task"
            asset.write_bytes(b"synthetic model")
            with patch.dict(sys.modules, {"cv2": cv, "mediapipe": mp}), \
                    patch.object(aimlab, "create_detector", return_value=detector), \
                    patch.object(aimlab, "model_file", return_value=asset), \
                    patch.object(aimlab.importlib.metadata, "version", return_value="test"), \
                    patch.object(aimlab, "extract_features", return_value=[1] * 12):
                worker.thread.start()
                worker.thread.join(3)
            self.assertFalse(worker.thread.is_alive())
            self.assertTrue(worker.errors.empty())
            self.assertEqual(worker.recording.processed, 20)
            self.assertEqual(worker.recording.valid, 16)
            capture.release.assert_called_once()
            worker.recording.finish()

    def test_start_stop_and_resolution_change_via_global_key_queue(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(aimlab, "ROOT", Path(folder)):
            app = aimlab.RecorderApp.__new__(aimlab.RecorderApp)
            app.worker = aimlab.CameraWorker(0, 1920, 1080)
            app.worker.ready = True
            app.worker.model = Mock(predict=Mock(return_value=(100, 200)))
            app.controls = Mock()
            app.controls.size.return_value = (1920, 1080)
            app.controls.foreground.return_value = "AimLab.exe"
            app.controls.messages.return_value = iter([1])
            app.root, app.status = Mock(), Mock()
            app.calibrate_button, app.stop_button = Mock(), Mock()
            app.width, app.height = 1920, 1080
            app.calibration_window, app.last_foreground = None, None
            app.last_monitor_check = 0
            app.camera_announced = True
            app.camera_error, app.last_camera_stage = None, None
            app.prepared = {"screen_width": 1920, "screen_height": 1080, "task_name": "Synthetic"}
            app.poll()
            self.assertIsNotNone(app.worker.recording)
            app.root.iconify.assert_called_once()
            now = time.perf_counter()
            app.worker.accept_frame(now, now + .01, [1] * 12)
            app.controls.messages.return_value = iter([3])
            app.poll()
            app.controls.messages.return_value = iter([])
            app.controls.size.return_value = (1280, 720)
            app.last_monitor_check = 0
            app.poll()
            self.assertIsNone(app.worker.recording)
            self.assertIsNone(app.worker.model)
            data = json.loads((app.last_path / "session.json").read_text(encoding="utf-8"))
            self.assertEqual(data["summary"]["stop_reason"], "screen_size_changed")
            self.assertIn("manual_marker", [r["event"] for r in rows(app.last_path / "events.csv")])

    @unittest.skipUnless(sys.platform == "win32", "Windows message queue required")
    def test_real_windows_hotkey_message_queue_on_own_thread(self):
        import ctypes
        from ctypes import wintypes
        controls = aimlab.WindowsControls()
        try:
            try:
                controls.register()
            except RuntimeError as error:
                self.skipTest(str(error))
            controls.user.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            # Send directly to our test thread; do not inject input into the user's apps.
            self.assertTrue(controls.user.PostThreadMessageW(controls.hotkey_thread.native_id, 0x312, 1, 0))
            deadline = time.perf_counter() + 2
            while controls.hotkeys.empty() and time.perf_counter() < deadline:
                time.sleep(.01)
            self.assertEqual(list(controls.messages()), [1])
            self.assertGreater(controls.size()[0], 0)
        finally:
            controls.close()
        self.assertFalse(controls.hotkey_thread.is_alive())

    def test_camera_fallback_checks_real_frame_before_accepting_backend(self):
        worker = aimlab.CameraWorker(0, 1920, 1080)
        failed, success = Mock(), Mock()
        failed.isOpened.return_value = True
        failed.read.return_value = (False, None)
        success.isOpened.return_value = True
        image = SimpleNamespace(shape=(480, 640, 3))
        success.read.return_value = (True, image)
        cv = SimpleNamespace(CAP_MSMF=2, CAP_DSHOW=1, VideoCapture=Mock(side_effect=[failed, success]))
        capture, result, backend = worker.open_camera(cv)
        self.assertIs(capture, success)
        self.assertIs(result, image)
        self.assertEqual(backend, "DirectShow")
        failed.release.assert_called_once()
        success.release.assert_not_called()
        failed.set.assert_not_called()
        self.assertEqual(cv.VideoCapture.call_args_list[0].args, (0, 2))

    def test_missing_camera_reports_actionable_error_and_releases_handles(self):
        worker = aimlab.CameraWorker(1, 1920, 1080)
        camera = Mock()
        camera.isOpened.return_value = False
        cv = SimpleNamespace(CAP_MSMF=2, CAP_DSHOW=1, VideoCapture=Mock(return_value=camera))
        with self.assertRaisesRegex(RuntimeError, "カメラ番号"):
            worker.open_camera(cv)
        self.assertEqual(camera.release.call_count, 2)

    def test_progress_and_error_stay_visible_without_enabling_calibration(self):
        app = aimlab.RecorderApp.__new__(aimlab.RecorderApp)
        app.worker = aimlab.CameraWorker(0, 1920, 1080)
        app.worker.stage = "カメラ0にMSMFで接続中です。"
        app.controls = Mock()
        app.controls.messages.return_value = iter([])
        app.controls.size.return_value = (1920, 1080)
        app.width, app.height = 1920, 1080
        app.root, app.status = Mock(), Mock()
        app.calibrate_button, app.stop_button = Mock(), Mock()
        app.camera_announced = False
        app.camera_error, app.last_camera_stage = None, None
        app.last_monitor_check = time.perf_counter()
        app.poll()
        app.status.set.assert_called_with("カメラ0にMSMFで接続中です。")
        app.calibrate_button.configure.assert_called_with(state="disabled")
        app.worker.errors.put("カメラを開けません")
        app.controls.messages.return_value = iter([])
        app.poll()
        app.status.set.assert_called_with("エラー：カメラを開けません")

    def test_retry_replaces_failed_worker_with_selected_camera_and_backend(self):
        app = aimlab.RecorderApp.__new__(aimlab.RecorderApp)
        app.worker = aimlab.CameraWorker(0, 1920, 1080)
        app.calibration_window = None
        app.width, app.height = 1920, 1080
        app.camera_number, app.camera_backend = Mock(), Mock()
        app.camera_number.get.return_value = "1"
        app.camera_backend.get.return_value = "MSMF"
        app.status, app.root = Mock(), Mock()
        replacement = Mock()
        with patch.object(aimlab, "CameraWorker", return_value=replacement) as factory:
            app.retry_camera()
        factory.assert_called_once_with(1, 1920, 1080, "MSMF")
        replacement.thread.start.assert_called_once()
        self.assertIs(app.worker, replacement)


if __name__ == "__main__":
    unittest.main()
