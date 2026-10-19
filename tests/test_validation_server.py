import copy
import json
from pathlib import Path
import tempfile
import unittest
import threading
import http.client
from http.server import ThreadingHTTPServer
from unittest.mock import patch
import server


class ValidationStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patch = patch.object(server, "RECORDINGS_DIR", self.root / "recordings")
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.run_id = "8a756db1-8596-4da3-82bc-4458f79d6e95"
        self.payload = {"run_id": self.run_id, "files": {
            "session.json": json.dumps({"schema": "gaze-validation-1.0.0", "metadata": {"run_id": self.run_id}}, ensure_ascii=False),
            "samples.csv": "valid,x\r\nfalse,\r\n", "trials.csv": "id,status\r\n1,aborted",
            "positions.csv": "point,mean\r\nV1,"}}

    def test_bundle_and_identical_retry(self):
        result = server.save_validation(self.payload)
        self.assertEqual(set(p.name for p in result.iterdir()), set(self.payload["files"]))
        self.assertEqual(result, server.save_validation(copy.deepcopy(self.payload)))
        self.assertTrue((result / "samples.csv").read_bytes().startswith(b"\xef\xbb\xbf"))

    def test_existing_data_never_overwritten(self):
        result = server.save_validation(self.payload)
        self.payload["files"]["samples.csv"] += "changed"
        with self.assertRaises(ValueError):
            server.save_validation(self.payload)
        self.assertNotIn("changed", (result / "samples.csv").read_text(encoding="utf-8-sig"))

    def test_rejects_path_traversal_extra_file_and_mismatched_id(self):
        for mutation in ("path", "extra", "identity"):
            payload = copy.deepcopy(self.payload)
            if mutation == "path": payload["run_id"] = "../escape"
            elif mutation == "extra": payload["files"]["../escape"] = "bad"
            else: payload["files"]["session.json"] = '{"metadata":{"run_id":"wrong"}}'
            with self.assertRaises(ValueError):
                server.save_validation(payload)

    def test_failed_write_does_not_publish_partial_bundle(self):
        with patch.object(Path, "write_text", side_effect=OSError("simulated disk failure")):
            with self.assertRaises(OSError):
                server.save_validation(self.payload)
        parent = self.root / "recordings" / "validation"
        self.assertEqual(list(parent.iterdir()), [])

    def test_http_endpoint_round_trip_and_rejected_payload(self):
        class QuietHandler(server.EyeTrackingHandler):
            def log_message(self, *_args):
                pass

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        try:
            with patch.object(server, "ROOT", self.root):
                for payload, expected_status in [(self.payload, 200), ({"run_id": "../bad"}, 400)]:
                    conn = http.client.HTTPConnection("127.0.0.1", httpd.server_port)
                    conn.request("POST", "/save-validation", body=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
                    response = conn.getresponse()
                    result = json.loads(response.read())
                    self.assertEqual(response.status, expected_status)
                    self.assertEqual(result["ok"], expected_status == 200)
                    conn.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
