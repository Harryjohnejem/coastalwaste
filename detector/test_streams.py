"""Unit tests for multi-stream configuration parsing."""

from __future__ import annotations

import json
import unittest

from streams import parse_detector_streams


class ParseDetectorStreamsTests(unittest.TestCase):
    def test_legacy_single_stream(self):
        configs = parse_detector_streams(
            streams_json="",
            camera_id="CAM-01",
            rtsp_url="rtsp://user:pass@192.168.1.13:554/stream1",
            go2rtc_frame_url="http://127.0.0.1:1990/api/frame.jpeg?src=cam01",
            sector="Sector B",
        )
        self.assertEqual(len(configs), 1)
        self.assertEqual(configs[0].camera_id, "CAM-01")
        self.assertIn("stream1", configs[0].rtsp_url)
        self.assertTrue(configs[0].enabled)

    def test_json_dual_lens_defaults_to_go2rtc_relay(self):
        payload = json.dumps(
            [
                {
                    "camera_id": "CAM-01",
                    "go2rtc_src": "cam01",
                    "rtsp_path": "/stream1",
                    "label": "Wide-Angle Lens",
                    "enabled": True,
                },
                {
                    "camera_id": "CAM-02",
                    "go2rtc_src": "cam02",
                    "rtsp_path": "/stream6",
                    "label": "Second Lens",
                    "enabled": True,
                },
            ]
        )
        configs = parse_detector_streams(
            streams_json=payload,
            camera_id="CAM-01",
            rtsp_url="",
            go2rtc_frame_url="",
            sector="Paco Beach",
            tapo_user="demo",
            tapo_pass="secret",
            tapo_host="192.168.1.13",
        )
        self.assertEqual(len(configs), 2)
        self.assertEqual(configs[0].go2rtc_src, "cam01")
        self.assertEqual(configs[1].go2rtc_src, "cam02")
        # Default: JPEG from go2rtc (empty RTSP) — reliable on Windows.
        self.assertEqual(configs[0].rtsp_url, "")
        self.assertEqual(configs[1].rtsp_url, "")
        self.assertIn("cam01", configs[0].jpeg_url)
        self.assertIn("cam02", configs[1].jpeg_url)

    def test_json_dual_lens_can_use_direct_tapo(self):
        payload = json.dumps(
            [
                {
                    "camera_id": "CAM-01",
                    "go2rtc_src": "cam01",
                    "rtsp_path": "/stream1",
                    "use_go2rtc_relay": False,
                    "enabled": True,
                },
            ]
        )
        configs = parse_detector_streams(
            streams_json=payload,
            camera_id="CAM-01",
            rtsp_url="",
            go2rtc_frame_url="",
            sector="Paco Beach",
            tapo_user="demo",
            tapo_pass="secret",
            tapo_host="192.168.1.13",
        )
        self.assertIn("/stream1", configs[0].rtsp_url)
        self.assertIn("secret", configs[0].rtsp_url)

    def test_disabled_stream_flag(self):
        payload = json.dumps(
            [
                {"camera_id": "CAM-01", "go2rtc_src": "cam01", "enabled": True},
                {"camera_id": "CAM-02", "go2rtc_src": "cam02", "enabled": False},
            ]
        )
        configs = parse_detector_streams(
            streams_json=payload,
            camera_id="CAM-01",
            rtsp_url="",
            go2rtc_frame_url="",
            sector="Sector B",
        )
        self.assertTrue(configs[0].enabled)
        self.assertFalse(configs[1].enabled)

    def test_explicit_rtsp_url_wins(self):
        payload = json.dumps(
            [
                {
                    "camera_id": "CAM-03",
                    "go2rtc_src": "cam03",
                    "rtsp_url": "rtsp://a:b@10.0.0.5:554/stream1",
                    "rtsp_path": "/stream6",
                }
            ]
        )
        configs = parse_detector_streams(
            streams_json=payload,
            camera_id="CAM-01",
            rtsp_url="",
            go2rtc_frame_url="",
            sector="Sector B",
            tapo_user="x",
            tapo_pass="y",
            tapo_host="192.168.1.13",
        )
        self.assertEqual(configs[0].rtsp_url, "rtsp://a:b@10.0.0.5:554/stream1")

    def test_trackers_are_independent_factories(self):
        from streams import new_byte_tracker

        a = new_byte_tracker()
        b = new_byte_tracker()
        self.assertIsNot(a, b)

    def test_tapo_env_isolates_second_camera_account(self):
        payload = json.dumps(
            [
                {
                    "camera_id": "CAM-01",
                    "go2rtc_src": "cam01",
                    "rtsp_path": "/stream1",
                    "use_go2rtc_relay": False,
                    "enabled": True,
                },
                {
                    "camera_id": "CAM-03",
                    "go2rtc_src": "cam03",
                    "rtsp_path": "/stream1",
                    "tapo_env": "TAPO2",
                    "use_go2rtc_relay": False,
                    "enabled": True,
                },
            ]
        )
        configs = parse_detector_streams(
            streams_json=payload,
            camera_id="CAM-01",
            rtsp_url="",
            go2rtc_frame_url="",
            sector="Paco Beach",
            tapo_user="demo",
            tapo_pass="first-secret",
            tapo_host="192.168.1.3",
            tapo_accounts={
                "TAPO2": ("paco", "second-secret", "192.168.1.18"),
            },
        )
        self.assertIn("192.168.1.3", configs[0].rtsp_url)
        self.assertIn("/stream1", configs[0].rtsp_url)
        self.assertNotIn("192.168.1.18", configs[0].rtsp_url)
        self.assertIn("192.168.1.18", configs[1].rtsp_url)
        self.assertNotIn("192.168.1.3", configs[1].rtsp_url)
        self.assertNotIn("second-secret", configs[0].jpeg_url)
        self.assertNotIn("first-secret", configs[1].jpeg_url)
        self.assertNotIn("second-secret", configs[1].jpeg_url)

    def test_second_camera_jpeg_urls_omit_credentials(self):
        payload = json.dumps(
            [
                {
                    "camera_id": "CAM-03",
                    "go2rtc_src": "cam03",
                    "rtsp_path": "/stream1",
                    "tapo_env": "TAPO2",
                    "label": "Paco Wide-Angle",
                    "sector": "Paco",
                    "enabled": True,
                },
                {
                    "camera_id": "CAM-04",
                    "go2rtc_src": "cam04",
                    "rtsp_path": "/stream6",
                    "tapo_env": "TAPO2",
                    "label": "Paco Telephoto",
                    "sector": "Paco",
                    "enabled": True,
                },
            ]
        )
        configs = parse_detector_streams(
            streams_json=payload,
            camera_id="CAM-01",
            rtsp_url="",
            go2rtc_frame_url="",
            sector="Paco Beach",
            tapo_user="demo",
            tapo_pass="first-secret",
            tapo_host="192.168.1.3",
            tapo_accounts={
                "TAPO2": ("paco", "second-secret", "192.168.1.18"),
            },
        )
        self.assertEqual(configs[0].rtsp_url, "")
        self.assertEqual(configs[1].rtsp_url, "")
        self.assertIn("src=cam03", configs[0].jpeg_url)
        self.assertIn("src=cam04", configs[1].jpeg_url)
        self.assertEqual(configs[0].sector, "Paco")
        self.assertEqual(configs[1].label, "Paco Telephoto")
        for cfg in configs:
            self.assertNotIn("second-secret", cfg.jpeg_url)
            self.assertNotIn("first-secret", cfg.jpeg_url)
            self.assertNotIn("paco", cfg.jpeg_url)

    def test_jpeg_capture_interval_is_separate_from_reconnect(self):
        from threading import Event

        from streams import LatestFrameReader

        reader = LatestFrameReader(
            "CAM-01",
            Event(),
            reconnect_s=0.5,
            capture_interval_s=0.1,
        )
        self.assertEqual(reader.reconnect_s, 0.5)
        self.assertAlmostEqual(reader.capture_interval_s, 0.1)


if __name__ == "__main__":
    unittest.main()
