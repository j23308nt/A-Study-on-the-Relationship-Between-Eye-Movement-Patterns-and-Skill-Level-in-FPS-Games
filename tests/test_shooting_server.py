import copy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
import server


class ShootingServerTests(unittest.TestCase):
    def test_bundle_is_immutable_and_requires_finalized_six_file_format(self):
        run_id = '8a756db1-8596-4da3-82bc-4458f79d6e95'
        record = {'schema': 'gaze-shooting-1.0.0', 'metadata': {'run_id': run_id, 'status': 'aborted'},
                  **{key: [] for key in ('frames', 'gaze', 'targets', 'shots', 'events')}}
        payload = {'run_id': run_id, 'files': {'session.json': json.dumps(record),
                   **{key + '.csv': 'run_id,id\r\n' for key in ('frames', 'gaze', 'targets', 'shots', 'events')}}}
        with tempfile.TemporaryDirectory() as folder, patch.object(server, 'RECORDINGS_DIR', Path(folder)):
            path = server.save_shooting(payload)
            self.assertEqual(path.parent.name, 'shooting')
            self.assertEqual(server.save_shooting(copy.deepcopy(payload)), path)
            self.assertEqual(len(list(path.iterdir())), 6)
            missing = copy.deepcopy(payload)
            del missing['files']['frames.csv']
            with self.assertRaises(ValueError): server.save_shooting(missing)
            modified = copy.deepcopy(payload)
            modified['files']['gaze.csv'] += 'changed'
            with self.assertRaises(ValueError): server.save_shooting(modified)
            record['metadata']['status'] = 'running'
            modified['files']['session.json'] = json.dumps(record)
            with self.assertRaises(ValueError): server.save_shooting(modified)

    def test_module_mime_health_and_save_endpoint(self):
        class Quiet(server.EyeTrackingHandler):
            def log_message(self, *_args): pass
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        try:
            conn = http.client.HTTPConnection('127.0.0.1', httpd.server_port)
            conn.request('GET', '/research-health')
            response = conn.getresponse()
            self.assertEqual(json.loads(response.read())['shooting_schema'], 'gaze-shooting-1.0.0')
            conn.request('GET', '/shooting.mjs')
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIn('javascript', response.getheader('Content-Type'))
            response.read()
            conn.request('POST', '/save-shooting', json.dumps({'run_id': '../bad', 'files': {}}), {'Content-Type': 'application/json'})
            response = conn.getresponse()
            self.assertEqual(response.status, 400)
            self.assertFalse(json.loads(response.read())['ok'])
            conn.close()
        finally:
            httpd.shutdown(); httpd.server_close(); worker.join(3)
