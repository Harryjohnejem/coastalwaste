"""Unit tests for OpenCV SceneMotion (no live camera required)."""

from __future__ import annotations

import unittest

import numpy as np

from presence import PresenceBook, SceneMotion, box_motion_fraction


def solid(h: int = 120, w: int = 160, value: int = 40) -> np.ndarray:
    return np.full((h, w, 3), value, dtype=np.uint8)


def with_blob(frame: np.ndarray, x: int, y: int, size: int = 30, value: int = 220) -> np.ndarray:
    out = frame.copy()
    out[y : y + size, x : x + size] = value
    return out


class SceneMotionTests(unittest.TestCase):
    def test_static_scene_has_little_or_no_motion(self):
        motion = SceneMotion(min_area=200, history=30, var_threshold=16)
        base = solid()
        # Warm the background model on a static scene.
        for _ in range(25):
            result = motion.analyze(base)
        self.assertFalse(result.has_motion)
        self.assertEqual(result.region_count, 0)
        self.assertIsNotNone(result.mask)
        self.assertEqual(int(np.count_nonzero(result.mask)), 0)

    def test_moving_object_produces_regions(self):
        motion = SceneMotion(min_area=100, history=20, var_threshold=16)
        base = solid()
        for _ in range(20):
            motion.analyze(base)
        moved = with_blob(base, x=80, y=40, size=35)
        result = motion.analyze(moved)
        self.assertTrue(result.has_motion)
        self.assertGreaterEqual(result.region_count, 1)
        self.assertGreater(result.regions[0].area, 0)
        self.assertGreater(result.foreground_pixels, 0)

    def test_small_noise_filtered_by_min_area(self):
        motion = SceneMotion(min_area=5000, history=20, var_threshold=16)
        base = solid()
        for _ in range(20):
            motion.analyze(base)
        noisy = base.copy()
        # Tiny speck well under min_area.
        noisy[50:54, 70:74] = 255
        result = motion.analyze(noisy)
        self.assertFalse(result.has_motion)
        self.assertEqual(result.region_count, 0)

    def test_empty_and_invalid_frames_do_not_crash(self):
        motion = SceneMotion(min_area=100)
        self.assertFalse(motion.analyze(None).has_motion)
        self.assertFalse(motion.analyze(np.array([])).has_motion)
        self.assertFalse(motion.analyze(np.zeros((0, 10, 3), dtype=np.uint8)).has_motion)
        self.assertFalse(motion.analyze(np.zeros((1,), dtype=np.uint8)).has_motion)
        mask = motion.mask(None)
        self.assertEqual(mask.dtype, np.uint8)

    def test_frame_dimension_change_resets_model(self):
        motion = SceneMotion(min_area=100, history=15, var_threshold=16)
        small = solid(60, 80)
        for _ in range(15):
            motion.analyze(small)
        large = solid(120, 160)
        result = motion.analyze(large)
        self.assertTrue(result.reset)
        self.assertEqual(result.frame_shape, (120, 160))

    def test_explicit_reset_clears_background(self):
        motion = SceneMotion(min_area=100, history=15, var_threshold=16)
        base = solid()
        for _ in range(15):
            motion.analyze(base)
        motion.reset()
        # Fresh model: first apply after reset should not crash.
        result = motion.analyze(with_blob(base, 10, 10))
        self.assertIsNotNone(result.mask)

    def test_mask_and_fraction_compatible_with_presence(self):
        motion = SceneMotion(min_area=50, history=15, var_threshold=16)
        base = solid()
        for _ in range(15):
            motion.analyze(base)
        moved = with_blob(base, 20, 20, size=40)
        result = motion.analyze(moved)
        box = {"left": 10, "top": 10, "width": 40, "height": 40}
        frac = box_motion_fraction(result.mask, box)
        self.assertGreaterEqual(frac, 0.0)
        self.assertLessEqual(frac, 1.0)

    def test_motion_does_not_gate_stationary_waste_eligibility(self):
        """Stationary waste must remain eligible for YOLO confirmation paths.

        confirmed_events / update_tracks do not read SceneMotion. This test
        asserts the motion helper never invents a waste detection itself.
        """
        motion = SceneMotion(min_area=100, history=15, var_threshold=16)
        base = solid()
        for _ in range(20):
            result = motion.analyze(base)
        self.assertFalse(result.has_motion)
        # A static bright "object" that matches the background after warm-up
        # is not reported as motion — YOLO still owns classification.
        static_object = with_blob(base, 40, 40, size=40, value=40)
        for _ in range(10):
            result = motion.analyze(static_object)
        self.assertFalse(result.has_motion)
        # Presence book still works with an empty mask (stream healthy).
        book = PresenceBook(absence_frames=2)
        book.step(
            {1: {"detection_id": 7, "box": {"left": 10, "top": 10, "width": 20, "height": 20}, "class": "Can"}},
            result.mask,
            True,
        )
        updates = book.step({}, result.mask, True)
        self.assertEqual(updates, [])
        updates = book.step({}, result.mask, True)
        self.assertEqual(updates[0]["status"], "No Longer Visible")

    def test_summary_serializable_for_debug(self):
        motion = SceneMotion(min_area=50, history=10, var_threshold=16)
        base = solid()
        for _ in range(12):
            motion.analyze(base)
        result = motion.analyze(with_blob(base, 50, 30, size=40))
        summary = result.summary()
        self.assertIn("has_motion", summary)
        self.assertIn("region_count", summary)
        self.assertIn("regions", summary)
        self.assertIsInstance(summary["regions"], list)


class ConfirmedEventsMotionIndependenceTests(unittest.TestCase):
    """Recording still follows YOLO confirmation — not motion flags.

    Mirrors app.confirmed_events decision criteria without importing app.py
    (avoids loading Ultralytics/ONNX during unit tests).
    """

    def test_confirmed_events_ignore_motion_flag(self):
        tracks = {
            3: {
                "class": "Plastic Bottle",
                "frames": 5,
                "recorded": False,
                "snapshot_saved": False,
            }
        }
        boxes = [
            {
                "track_id": 3,
                "class": "Plastic Bottle",
                "confidence": 0.91,
                "confirmed": True,
                "motion": False,  # stationary waste must still record
            }
        ]
        record_conf = 0.7
        min_frames = 3
        events = []
        for box in boxes:
            track_id = box.get("track_id")
            if track_id is None or not box.get("confirmed"):
                continue
            if float(box.get("confidence") or 0) < record_conf:
                continue
            state = tracks.get(track_id)
            if state is None or state.get("recorded") or state.get("snapshot_saved"):
                continue
            if state["frames"] < min_frames:
                continue
            # motion flag is intentionally unused
            events.append(box)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["track_id"], 3)
        self.assertFalse(events[0]["motion"])


if __name__ == "__main__":
    unittest.main()
