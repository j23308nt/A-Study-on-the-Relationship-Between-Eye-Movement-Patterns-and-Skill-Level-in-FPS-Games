from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import re
import os
import tempfile
import shutil


ROOT = Path(__file__).resolve().parent
RECORDINGS_DIR = ROOT / "recordings"


class EyeTrackingHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "application/javascript", ".js": "application/javascript"}

    def do_GET(self):
        if self.path == "/research-health":
            self.send_json({"service": "eye-tracking-research", "shooting_schema": "gaze-shooting-1.0.0", "root": str(ROOT)})
            return
        super().do_GET()

    def do_POST(self):
        if self.path not in ("/save-csv", "/save-validation", "/save-aim", "/save-shooting"):
            self.send_error(404, "Not found")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 32 * 1024 * 1024:
                raise ValueError("Invalid payload size (maximum 32 MiB)")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if self.path == "/save-shooting":
                path = save_shooting(payload)
                self.send_json({"ok": True, "path": str(path.relative_to(ROOT))})
                return
            if self.path in ("/save-validation", "/save-aim"):
                path = save_validation(payload) if self.path == "/save-validation" else save_aim(payload)
                self.send_json({"ok": True, "path": str(path.relative_to(ROOT))})
                return
            filename = safe_filename(payload.get("filename", "eye-tracking.csv"))
            csv_text = payload["csv"]
            if not isinstance(csv_text, str) or not csv_text.strip():
                raise ValueError("CSV is empty")

            RECORDINGS_DIR.mkdir(exist_ok=True)
            path = RECORDINGS_DIR / filename
            path.write_text(csv_text, encoding="utf-8-sig", newline="")
            self.send_json({"ok": True, "path": str(path.relative_to(ROOT))})
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)}, status=400)

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def safe_filename(name):
    name = Path(str(name)).name
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", name)
    if not name.lower().endswith(".csv"):
        name += ".csv"
    return name or "eye-tracking.csv"


def save_validation(payload):
    return save_bundle(payload, "validation", "gaze-validation-1.0.0",
                       {"session.json", "samples.csv", "trials.csv", "positions.csv"})


def save_shooting(payload):
    session = json.loads(payload.get("files", {}).get("session.json", "{}"))
    if not all(isinstance(session.get(key), list) for key in ("frames", "gaze", "targets", "shots", "events")):
        raise ValueError("Shooting recording arrays are missing")
    if session.get("metadata", {}).get("status") not in ("completed", "aborted"):
        raise ValueError("Shooting recording must be finalized")
    return save_bundle(payload, "shooting", "gaze-shooting-1.0.0",
                       {"session.json", "gaze.csv", "frames.csv", "targets.csv", "shots.csv", "events.csv"})


def save_aim(payload):
    session = json.loads(payload.get("files", {}).get("session.json", "{}"))
    expected = {"session.json", "gaze.csv", "trials.csv", "clicks.csv"}
    if "cursor" in session:
        if not isinstance(session["cursor"], list):
            raise ValueError("Cursor samples must be an array")
        expected.add("cursor.csv")
    elif session.get("metadata", {}).get("cursor_recording"):
        raise ValueError("Cursor recording is enabled but samples are missing")
    return save_bundle(payload, "aim", "gaze-aim-1.0.0",
                       expected)


def save_bundle(payload, category, schema, expected):
    """Publish a complete, immutable bundle. Identical retries are idempotent."""
    run_id = payload.get("run_id", "")
    if not isinstance(run_id, str) or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", run_id):
        raise ValueError("Invalid run ID")
    files = payload.get("files")
    if not isinstance(files, dict) or set(files) != expected:
        raise ValueError("Recording bundle file names do not match its format")
    if any(not isinstance(value, str) or not value.strip() for value in files.values()):
        raise ValueError("Recording files must be nonempty text")
    session = json.loads(files["session.json"])
    if session.get("metadata", {}).get("run_id") != run_id or session.get("schema") != schema:
        raise ValueError("Recording metadata does not match the run ID or schema")
    parent = RECORDINGS_DIR / category
    parent.mkdir(parents=True, exist_ok=True)
    destination = parent / run_id

    def identical():
        return destination.is_dir() and set(p.name for p in destination.iterdir()) == expected and all(
            (destination / name).read_text(encoding="utf-8-sig") == value.replace("\r\n", "\n")
            for name, value in files.items()
        )

    if destination.exists():
        if identical():
            return destination
        raise ValueError("This run ID already exists with different data; nothing was overwritten")
    temporary = Path(tempfile.mkdtemp(prefix=f".{category}-", dir=parent))
    try:
        for name, value in files.items():
            encoding = "utf-8-sig" if name.endswith(".csv") else "utf-8"
            (temporary / name).write_text(value, encoding=encoding, newline="")
        try:
            os.rename(temporary, destination)
        except OSError:
            if not identical():
                raise
        return destination
    finally:
        # Only remove our own unpublished temporary directory, never recorded runs.
        if temporary.exists():
            shutil.rmtree(temporary)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    os.chdir(ROOT)
    server = ThreadingHTTPServer(("localhost", args.port), EyeTrackingHandler)
    print(f"Serving HTTP on http://localhost:{args.port}/")
    print(f"CSV recordings will be saved to: {RECORDINGS_DIR}")
    server.serve_forever()
