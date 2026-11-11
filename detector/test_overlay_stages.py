"""Visual detection stages are independent of Laravel recording."""

from __future__ import annotations

import unittest

from streams import annotate_detection_stages


class OverlayStageTests(unittest.TestCase):
    def test_yolo_box_without_track_is_detected(self):
        boxes = [{"class": "Plastic Bottle", "confidence": 0.55, "confirmed": False}]
        annotate_detection_stages(boxes, {})
        self.assertEqual(boxes[0]["stage"], "detected")
        self.assertTrue(boxes[0]["display"])

    def test_tracked_unconfirmed_is_confirming(self):
        boxes = [
            {
                "class": "Can",
                "confidence": 0.8,
                "confirmed": False,
                "track_id": 7,
            }
        ]
        tracks = {7: {"frames": 1, "recorded": False}}
        annotate_detection_stages(boxes, tracks)
        self.assertEqual(boxes[0]["stage"], "confirming")

    def test_recorded_track_marked_recorded(self):
        boxes = [
            {
                "class": "Can",
                "confidence": 0.9,
                "confirmed": True,
                "track_id": 3,
            }
        ]
        tracks = {3: {"frames": 5, "recorded": True, "saved_id": 99}}
        annotate_detection_stages(boxes, tracks)
        self.assertEqual(boxes[0]["stage"], "recorded")

    def test_confirmation_not_required_for_display_flag(self):
        boxes = [{"class": "Ecobag", "confidence": 0.4, "confirmed": False}]
        annotate_detection_stages(boxes, {})
        self.assertTrue(boxes[0]["display"])
        self.assertFalse(boxes[0]["confirmed"])

    def test_provisional_box_stays_detected_even_with_track(self):
        boxes = [
            {
                "class": "Can",
                "confidence": 0.45,
                "confirmed": False,
                "provisional": True,
                "track_id": 2,
            }
        ]
        annotate_detection_stages(boxes, {2: {"frames": 1, "recorded": False}})
        self.assertEqual(boxes[0]["stage"], "detected")
        self.assertTrue(boxes[0]["display"])


if __name__ == "__main__":
    unittest.main()
