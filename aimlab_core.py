"""Calibration and streaming storage for the native Aim Lab recorder.

No camera or Windows imports here: storage can be tested without a device.
"""
from datetime import datetime, timezone
from pathlib import Path
import csv
import json
import math
import os
import threading
import time
import uuid


SCHEMA = "gaze-aimlab-1.0.0"
GAZE_FIELDS = ["index", "captured_at", "elapsed_ms", "phase", "x", "y",
               "delta_time_ms", "delta_x", "delta_y", "distance_px",
               "speed_px_per_second", "screen_width", "screen_height", "face_detected"]
SAMPLE_FIELDS = ["frame_id", "processing_start_ms", "processing_end_ms", "captured_at",
                 "elapsed_ms", "valid", "failure_reason", "raw_x", "raw_y", "x", "y"]
EVENT_FIELDS = ["event", "elapsed_ms", "utc", "foreground_process"]


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def extract_features(landmarks):
    if len(landmarks) < 478:
        return None

    def distance(a, b):
        return math.hypot(a.x - b.x, a.y - b.y)

    def eye(indices, outer, inner, upper, lower):
        ix = sum(landmarks[i].x for i in indices) / 5
        iy = sum(landmarks[i].y for i in indices) / 5
        a, b, c, d = (landmarks[i] for i in (outer, inner, upper, lower))
        return ((ix - (a.x + b.x) / 2) / max(.0001, distance(a, b)),
                (iy - (c.y + d.y) / 2) / max(.0001, distance(c, d)))

    lx, ly = eye(range(468, 473), 33, 133, 159, 145)
    rx, ry = eye(range(473, 478), 362, 263, 386, 374)
    cx = (landmarks[10].x + landmarks[152].x) / 2
    cy = (landmarks[10].y + landmarks[152].y) / 2
    values = [1, lx, ly, rx, ry, (lx + rx) / 2, (ly + ry) / 2, cx, cy,
              distance(landmarks[10], landmarks[152]), landmarks[1].x - cx, landmarks[1].y - cy]
    return values if all(math.isfinite(v) for v in values) else None


class Calibration:
    def __init__(self, features, targets):
        import numpy as np
        x, y = np.asarray(features, dtype=float), np.asarray(targets, dtype=float)
        if x.ndim != 2 or x.shape[1] != 12 or len(x) < 45 or y.shape != (len(x), 2):
            raise ValueError("9点×5回の校正データが必要です。")
        if not np.isfinite(x).all() or not np.isfinite(y).all():
            raise ValueError("校正データが不正です。")
        # Standardize nonconstant terms; leave intercept unpenalized.
        self.mean = x.mean(axis=0)
        self.scale = x.std(axis=0)
        self.mean[0], self.scale[0] = 0, 1
        self.scale[self.scale < 1e-8] = 1
        z = (x - self.mean) / self.scale
        penalty = np.eye(12) * .1
        penalty[0, 0] = 0
        self.coefficients = np.linalg.solve(z.T @ z + penalty, z.T @ y)

    def predict(self, features, width, height):
        import numpy as np
        value = ((np.asarray(features) - self.mean) / self.scale) @ self.coefficients
        return float(value[0] * width), float(value[1] * height)

    def snapshot(self):
        return {"feature_mean": self.mean.tolist(), "feature_scale": self.scale.tolist(),
                "coefficients_normalized_xy": self.coefficients.tolist(), "ridge_lambda": .1}


class Smoother:
    def __init__(self):
        self.previous = None

    def apply(self, x, y, now):
        if self.previous is None or now - self.previous[2] > .2:
            self.previous = (x, y, now)
            return round(x), round(y)
        px, py, then = self.previous
        dx, dy = x - px, y - py
        distance = math.hypot(dx, dy)
        if distance < 3.5:
            self.previous = (px, py, now)
            return round(px), round(py)
        max_step = 2600 * max(.001, now - then)
        if distance > max_step:
            dx, dy = dx * max_step / distance, dy * max_step / distance
        alpha = min(.48, .1 + math.hypot(dx, dy) / 180 * .38)
        x, y = px + dx * alpha, py + dy * alpha
        self.previous = (x, y, now)
        return round(x), round(y)


class Recording:
    """Write every processed frame immediately; never overwrite an existing run."""
    def __init__(self, root, metadata, clock=time.perf_counter):
        self.clock = clock
        self.started = clock()
        self.lock = threading.RLock()
        self.path = Path(root) / str(uuid.uuid4())
        self.path.mkdir(parents=True, exist_ok=False)
        self.metadata = dict(metadata, run_id=self.path.name, started_at=utc_now(),
                             coordinate_space="primary monitor physical pixels; top-left origin",
                             clock="time.perf_counter; UTC is processing time, not camera exposure",
                             synchronization="manual global hotkeys; no Aim Lab telemetry")
        self.closed = False
        self.processed = self.valid = 0
        self.max_gap_ms = 0
        self.last_processed = None
        self.previous = None
        self.files = {}
        self.writers = {}
        for name, fields in [("gaze.csv", GAZE_FIELDS), ("samples.csv", SAMPLE_FIELDS), ("events.csv", EVENT_FIELDS)]:
            stream = (self.path / name).open("w", encoding="utf-8-sig", newline="")
            writer = csv.DictWriter(stream, fieldnames=fields)
            writer.writeheader()
            stream.flush()
            self.files[name], self.writers[name] = stream, writer
        self._session("recording")
        self.event("recording_start")

    def _session(self, status, reason=None):
        data = {"schema": SCHEMA, "metadata": self.metadata,
                "summary": {"status": status, "stop_reason": reason, "processed_frames": self.processed,
                            "valid_frames": self.valid, "invalid_frames": self.processed - self.valid,
                            "max_processed_gap_ms": self.max_gap_ms}}
        temporary = self.path / "session.json.tmp"
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        os.replace(temporary, self.path / "session.json")

    def _row(self, name, row):
        self.writers[name].writerow(row)
        self.files[name].flush()

    def event(self, name, foreground="", now=None):
        with self.lock:
            if not self.closed:
                self._row("events.csv", dict(event=name, elapsed_ms=round(((self.clock() if now is None else now) - self.started) * 1000, 3),
                                             utc=utc_now(), foreground_process=foreground))

    def frame(self, start, end, raw=None, point=None, reason=""):
        with self.lock:
            if self.closed or start < self.started:
                return
            good = (raw is not None and point is not None and all(math.isfinite(v) for v in (*raw, *point)))
            elapsed = round((start - self.started) * 1000, 3)
            if self.last_processed is not None:
                self.max_gap_ms = max(self.max_gap_ms, round((start - self.last_processed) * 1000, 3))
            self.last_processed = start
            self.processed += 1
            stamp = utc_now()
            self._row("samples.csv", dict(frame_id=self.processed, processing_start_ms=elapsed,
                      processing_end_ms=round((end - self.started) * 1000, 3), captured_at=stamp,
                      elapsed_ms=elapsed, valid=int(good), failure_reason="" if good else reason or "nonfinite_prediction",
                      raw_x=raw[0] if good else "", raw_y=raw[1] if good else "",
                      x=point[0] if good else "", y=point[1] if good else ""))
            if not good:
                self.previous = None
                return
            self.valid += 1
            x, y = point
            dt = elapsed - self.previous[2] if self.previous else 0
            continuous = self.previous is not None and 0 < dt <= 200
            dx, dy = (x - self.previous[0], y - self.previous[1]) if continuous else (0, 0)
            distance = math.hypot(dx, dy)
            self._row("gaze.csv", dict(index=self.valid, captured_at=stamp, elapsed_ms=elapsed, phase="aimlab",
                      x=x, y=y, delta_time_ms=dt if continuous else 0, delta_x=dx, delta_y=dy,
                      distance_px=round(distance, 3), speed_px_per_second=round(distance / (dt / 1000), 3) if continuous else 0,
                      screen_width=self.metadata["screen_width"], screen_height=self.metadata["screen_height"], face_detected=1))
            self.previous = x, y, elapsed

    def finish(self, reason="manual_stop", foreground=""):
        with self.lock:
            if self.closed:
                return self.path
            self.event("recording_stop", foreground)
            self.metadata["ended_at"] = utc_now()
            self.metadata["duration_ms"] = round((self.clock() - self.started) * 1000, 3)
            self._session("stopped", reason)
            for stream in self.files.values():
                stream.close()
            self.closed = True
            return self.path
