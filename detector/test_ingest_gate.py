import unittest

import app as detector_app


class IngestGateTests(unittest.TestCase):
    def setUp(self):
        detector_app._camera_ingest_blocked_until.clear()

    def test_missing_camera_body_is_detected(self):
        self.assertTrue(
            detector_app.ingest_looks_like_missing_camera(
                422, '{"message":"Camera not found."}'
            )
        )
        self.assertFalse(detector_app.ingest_looks_like_missing_camera(200, "ok"))
        self.assertFalse(detector_app.ingest_looks_like_missing_camera(422, "class mismatch"))

    def test_block_pauses_ingest_then_expires(self):
        detector_app.block_camera_ingest("CAM-04", seconds=30, now=100.0)
        self.assertFalse(detector_app.camera_ingest_allowed("CAM-04", now=110.0))
        self.assertTrue(detector_app.camera_ingest_allowed("CAM-04", now=131.0))
        self.assertTrue(detector_app.camera_ingest_allowed("CAM-01", now=110.0))

    def test_retry_payload_drops_snapshot(self):
        pending = {
            5: {"class": "Ecobag", "subtitle": "Track 5", "snapshot": "abc"},
        }
        first = detector_app._detections_payload(pending, [5], include_snapshot=True)
        retry = detector_app._detections_payload(pending, [5], include_snapshot=False)
        self.assertEqual(first[0]["snapshot"], "abc")
        self.assertNotIn("snapshot", retry[0])


if __name__ == "__main__":
    unittest.main()
