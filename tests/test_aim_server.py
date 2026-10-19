import copy
import http.client
import json
from http.server import ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import server


class AimStorageTests(unittest.TestCase):
    def test_cursor_bundle_requires_fifth_file_and_supports_identical_retry(self):
        run_id = "8a756db1-8596-4da3-82bc-4458f79d6e95"
        payload = {"run_id": run_id, "files": {
            "session.json": json.dumps({"schema": "gaze-aim-1.0.0", "metadata": {"run_id": run_id, "cursor_recording": {"version": 1}}, "cursor": []}),
            "gaze.csv": "frame_id,x", "clicks.csv": "click_id,x", "trials.csv": "trial_id,status", "cursor.csv": "sample_id,time_ms,x,y"}}
        with tempfile.TemporaryDirectory() as temp, patch.object(server, "RECORDINGS_DIR", Path(temp)):
            missing = copy.deepcopy(payload)
            del missing["files"]["cursor.csv"]
            with self.assertRaises(ValueError):
                server.save_aim(missing)
            path = server.save_aim(payload)
            self.assertEqual(len(list(path.iterdir())), 5)
            self.assertEqual(server.save_aim(payload), path)
            payload["files"]["cursor.csv"] += "changed"
            with self.assertRaises(ValueError):
                server.save_aim(payload)

    def test_aim_bundle_retry_and_no_overwrite(self):
        run_id = "8a756db1-8596-4da3-82bc-4458f79d6e95"
        payload = {"run_id": run_id, "files": {
            "session.json": json.dumps({"schema": "gaze-aim-1.0.0", "metadata": {"run_id": run_id}}),
            "gaze.csv": "frame_id,x,y\r\n1,10,20", "clicks.csv": "click_id,outcome\r\n1,hit",
            "trials.csv": "trial_id,status\r\n1,hit"}}
        with tempfile.TemporaryDirectory() as temp, patch.object(server, "RECORDINGS_DIR", Path(temp)):
            path = server.save_aim(payload)
            self.assertEqual(path.parent.name, "aim")
            self.assertEqual(server.save_aim(copy.deepcopy(payload)), path)
            with self.assertRaises(ValueError):
                server.save_validation(payload)
            payload["files"]["gaze.csv"] += "changed"
            with self.assertRaises(ValueError):
                server.save_aim(payload)
            self.assertNotIn("changed", (path / "gaze.csv").read_text(encoding="utf-8-sig"))

    def test_endpoint_and_invalid_file_set(self):
        class QuietHandler(server.EyeTrackingHandler):
            def log_message(self, *_args):
                pass
        run_id = "8a756db1-8596-4da3-82bc-4458f79d6e95"
        payload = {"run_id": run_id, "files": {
            "session.json": json.dumps({"schema": "gaze-aim-1.0.0", "metadata": {"run_id": run_id}}),
            "gaze.csv": "frame_id,x", "clicks.csv": "click_id,x", "trials.csv": "trial_id,status"}}
        cursor_id = "b79d49da-ece3-439b-a033-8f5a2a851bad"
        cursor_payload = {"run_id": cursor_id, "files": {
            **payload["files"],
            "session.json": json.dumps({"schema": "gaze-aim-1.0.0",
                                        "metadata": {"run_id": cursor_id, "cursor_recording": {"version": 1}},
                                        "cursor": []}),
            "cursor.csv": "sample_id,time_ms,x,y"}}
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory() as temp, patch.object(server, "ROOT", Path(temp)), patch.object(server, "RECORDINGS_DIR", Path(temp) / "recordings"):
                for body, status in [(payload, 200), (cursor_payload, 200), (cursor_payload, 200), ({"run_id": "../escape"}, 400),
                                     ({**payload, "files": {**payload["files"], "../extra": "x"}}, 400)]:
                    conn = http.client.HTTPConnection("127.0.0.1", httpd.server_port)
                    conn.request("POST", "/save-aim", json.dumps(body).encode(), {"Content-Type": "application/json"})
                    response = conn.getresponse()
                    self.assertEqual(response.status, status)
                    self.assertEqual(json.loads(response.read())["ok"], status == 200)
                    conn.close()
                saved = Path(temp) / "recordings" / "aim" / cursor_id
                self.assertEqual({p.name for p in saved.iterdir()}, set(cursor_payload["files"]))
                for name, content in cursor_payload["files"].items():
                    self.assertEqual((saved / name).read_text(encoding="utf-8-sig"), content)
        finally:
            httpd.shutdown()
            httpd.server_close()
            worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
