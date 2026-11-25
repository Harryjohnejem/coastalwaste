import unittest

import numpy as np

from presence import PresenceBook, box_motion_fraction


BOX = {"left": 10, "top": 10, "width": 20, "height": 20}


class PresenceBookTests(unittest.TestCase):
    def test_visible_track_stays_present(self):
        book = PresenceBook(absence_frames=3)
        active = {1: {"detection_id": 10, "box": BOX, "class": "Plastic Bottle"}}
        for _ in range(5):
            self.assertEqual(book.step(active, None, stream_ok=True), [])

    def test_one_miss_does_not_clean(self):
        book = PresenceBook(absence_frames=3)
        book.step({1: {"detection_id": 10, "box": BOX, "class": "Plastic Bottle"}}, None, True)
        self.assertEqual(book.step({}, None, True), [])

    def test_continued_absence_marks_cleaned_once(self):
        book = PresenceBook(absence_frames=3)
        book.step({1: {"detection_id": 10, "box": BOX, "class": "Plastic Bottle"}}, None, True)
        self.assertEqual(book.step({}, None, True), [])
        self.assertEqual(book.step({}, None, True), [])
        updates = book.step({}, None, True)
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["detection_id"], 10)
        self.assertEqual(updates[0]["status"], "No Longer Visible")
        self.assertEqual(book.step({}, None, True), [])

    def test_time_based_clean_after_seconds_and_two_frames(self):
        book = PresenceBook(absence_frames=10, absence_seconds=4.0, min_absent_frames=2)
        seen = {1: {"detection_id": 10, "box": BOX, "class": "Plastic Bottle"}}
        book.step(seen, None, True, now=100.0)
        # One slow frame missing: never cleaned on a single miss.
        self.assertEqual(book.step({}, None, True, now=106.0), [])
        # Second miss, 5 s after the first: cleaned without waiting for 10 frames.
        updates = book.step({}, None, True, now=111.0)
        self.assertEqual([u["status"] for u in updates], ["No Longer Visible"])

    def test_time_based_waits_for_seconds_on_fast_frames(self):
        book = PresenceBook(absence_frames=10, absence_seconds=4.0, min_absent_frames=2)
        book.step({1: {"detection_id": 10, "box": BOX, "class": "Plastic Bottle"}}, None, True, now=100.0)
        self.assertEqual(book.step({}, None, True, now=100.5), [])
        self.assertEqual(book.step({}, None, True, now=101.0), [])
        self.assertEqual(book.step({}, None, True, now=103.0), [])
        updates = book.step({}, None, True, now=104.6)
        self.assertEqual(len(updates), 1)

    def test_reappearing_resets_absence_timer(self):
        book = PresenceBook(absence_frames=10, absence_seconds=4.0, min_absent_frames=2)
        seen = {1: {"detection_id": 10, "box": BOX, "class": "Plastic Bottle"}}
        book.step(seen, None, True, now=100.0)
        book.step({}, None, True, now=101.0)
        book.step(seen, None, True, now=102.0)
        self.assertEqual(book.step({}, None, True, now=103.0), [])
        self.assertEqual(book.step({}, None, True, now=105.0), [])
        self.assertEqual(len(book.step({}, None, True, now=107.5)), 1)

    def test_camera_outage_does_not_clean(self):
        book = PresenceBook(absence_frames=2)
        book.step({1: {"detection_id": 10, "box": BOX, "class": "Can"}}, None, True)
        self.assertEqual(book.step({}, None, stream_ok=False), [])
        self.assertEqual(book.step({}, None, stream_ok=False), [])
        self.assertEqual(book.watch[10]["absent"], 0)

    def test_motion_in_last_box_does_not_block_pickup(self):
        book = PresenceBook(absence_frames=2, motion_hold=0.1)
        book.step({1: {"detection_id": 10, "box": BOX, "class": "Can"}}, None, True)
        mask = np.zeros((100, 100), dtype=np.uint8)
        mask[10:30, 10:30] = 255
        self.assertEqual(book.step({}, mask, True), [])
        self.assertEqual(book.watch[10]["absent"], 1)
        updates = book.step({}, mask, True)
        self.assertEqual(updates[0]["status"], "No Longer Visible")

    def test_other_class_nearby_does_not_prevent_clean(self):
        book = PresenceBook(absence_frames=2)
        book.step({1: {"detection_id": 10, "box": BOX, "class": "Can"}}, None, True)
        scene = [{"left": 12, "top": 11, "width": 18, "height": 18, "class": "Plastic Wrapper"}]
        self.assertEqual(book.step({}, None, True, scene_boxes=scene), [])
        updates = book.step({}, None, True, scene_boxes=scene)
        self.assertEqual(updates[0]["status"], "No Longer Visible")

    def test_yolo_box_in_frame_prevents_clean(self):
        book = PresenceBook(absence_frames=2)
        book.step({1: {"detection_id": 10, "box": BOX, "class": "Can"}}, None, True)
        scene = [{"left": 12, "top": 11, "width": 18, "height": 18, "class": "Can"}]
        self.assertEqual(book.step({}, None, True, scene_boxes=scene), [])
        self.assertEqual(book.step({}, None, True, scene_boxes=scene), [])
        self.assertEqual(book.watch[10]["absent"], 0)

    def test_other_detection_is_unchanged(self):
        book = PresenceBook(absence_frames=2)
        book.step({
            1: {"detection_id": 10, "box": BOX, "class": "Can"},
            2: {"detection_id": 11, "box": BOX, "class": "Ecobag"},
        }, None, True)
        updates = book.step(
            {2: {"detection_id": 11, "box": BOX, "class": "Ecobag"}},
            None,
            True,
        )
        self.assertEqual(updates, [])
        updates = book.step(
            {2: {"detection_id": 11, "box": BOX, "class": "Ecobag"}},
            None,
            True,
        )
        self.assertEqual([row["detection_id"] for row in updates], [10])

    def test_motion_fraction_uses_box_region(self):
        mask = np.zeros((100, 100), dtype=np.uint8)
        mask[10:30, 10:30] = 255
        self.assertGreater(box_motion_fraction(mask, BOX), 0.9)
        self.assertEqual(box_motion_fraction(mask, {"left": 80, "top": 80, "width": 10, "height": 10}), 0.0)


if __name__ == "__main__":
    unittest.main()
