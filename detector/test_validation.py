"""Three-frame confirmation and overlay hold, without loading the camera model."""

from __future__ import annotations

import unittest

from app import (
    adopt_existing_tracks,
    confirmed_events,
    filter_overlay_boxes,
    retain_active_overlay_boxes,
    update_tracks,
)


def box(score: float, track_id: int = 15, label: str = "Plastic Bottle") -> dict:
    return {
        "class": label,
        "confidence": score,
        "track_id": track_id,
        "left": 10,
        "top": 20,
        "width": 12,
        "height": 18,
    }


class ConsecutiveFrameTests(unittest.TestCase):
    def test_first_solid_look_records_the_highest_score(self):
        tracks: dict = {}
        first = update_tracks(tracks, [box(0.91)], now=0, min_frames=3, record_conf=0.80)
        self.assertTrue(first[0]["confirmed"])
        events = confirmed_events(tracks, first, {}, now=0, min_frames=3, cooldown_s=0, record_conf=0.80)
        self.assertEqual(len(events), 1)
        self.assertAlmostEqual(events[0]["validation_confidence"], 0.91)
        tracks[15]["recorded"] = True
        tracks[15]["queued_confidence"] = 0.91
        update_tracks(tracks, [box(0.87)], now=1, min_frames=3, record_conf=0.80)
        higher = update_tracks(tracks, [box(0.94)], now=2, min_frames=3, record_conf=0.80)
        self.assertFalse(higher[0]["confirmed"])
        self.assertTrue(higher[0]["confidence_upgrade"])
        self.assertAlmostEqual(higher[0]["validation_confidence"], 0.94)
        self.assertEqual(
            confirmed_events(tracks, higher, {}, now=2, min_frames=3, cooldown_s=0, record_conf=0.80),
            [],
        )

    def test_one_frame_at_80_percent_is_recorded(self):
        tracks: dict = {}
        seen = update_tracks(tracks, [box(0.81)], now=0, min_frames=3, record_conf=0.80)
        self.assertTrue(seen[0]["confirmed"])
        self.assertAlmostEqual(seen[0]["validation_confidence"], 0.81)
        self.assertEqual(
            len(confirmed_events(tracks, seen, {}, now=0, min_frames=3, cooldown_s=0, record_conf=0.80)),
            1,
        )

    def test_records_on_the_first_look_at_80_percent(self):
        tracks: dict = {}
        below = update_tracks(tracks, [box(0.79, label="Can")], now=0, min_frames=1, record_conf=0.80)
        self.assertFalse(below[0]["confirmed"])
        hit = update_tracks(tracks, [box(0.80, label="Can")], now=1, min_frames=1, record_conf=0.80)
        self.assertTrue(hit[0]["confirmed"])
        self.assertAlmostEqual(hit[0]["confidence"], 0.80)
        self.assertAlmostEqual(hit[0]["validation_confidence"], 0.80)

    def test_a_weaker_look_does_not_erase_the_saved_score(self):
        tracks: dict = {}
        update_tracks(tracks, [box(0.92)], now=0, min_frames=3, record_conf=0.80)
        tracks[15]["recorded"] = True
        tracks[15]["queued_confidence"] = 0.92
        seen = update_tracks(tracks, [box(0.65)], now=1, min_frames=3, record_conf=0.80)
        self.assertFalse(seen[0]["confirmed"])
        self.assertFalse(seen[0]["confidence_upgrade"])
        self.assertAlmostEqual(seen[0]["validation_confidence"], 0.92)

    def test_one_wrong_label_does_not_reset_or_rename(self):
        tracks: dict = {}
        update_tracks(tracks, [box(0.91)], now=0, min_frames=3, record_conf=0.80)
        update_tracks(tracks, [box(0.90)], now=1, min_frames=3, record_conf=0.80)
        changed = update_tracks(
            tracks,
            [box(0.96, label="Can")],
            now=2,
            min_frames=3,
            record_conf=0.80,
        )
        self.assertEqual(changed[0]["class"], "Plastic Bottle")
        self.assertTrue(changed[0]["confirmed"])
        self.assertEqual(tracks[15]["class"], "Plastic Bottle")

    def test_repeated_new_class_replaces_the_old_one(self):
        tracks: dict = {}
        for index, score in enumerate((0.91, 0.90)):
            update_tracks(tracks, [box(score)], now=index, min_frames=3, record_conf=0.80)
        seen = None
        for index, score in enumerate((0.93, 0.94, 0.95), start=2):
            seen = update_tracks(
                tracks,
                [box(score, label="Can")],
                now=index,
                min_frames=3,
                record_conf=0.80,
            )
        self.assertEqual(tracks[15]["class"], "Can")
        self.assertTrue(seen[0]["confirmed"])

    def test_new_track_id_on_the_same_object_is_kept(self):
        tracks: dict = {}
        update_tracks(tracks, [box(0.91)], now=0, min_frames=3, record_conf=0.80)
        moved = box(0.70, track_id=99)
        moved["left"] = 11
        moved["top"] = 21
        adopt_existing_tracks([moved], tracks, now=1, lost_timeout_s=8)
        self.assertEqual(moved["track_id"], 15)

    def test_new_id_with_wrapper_label_still_adopts_the_recorded_object(self):
        tracks: dict = {}
        update_tracks(tracks, [box(0.91, label="Ecobag")], now=0, min_frames=3, record_conf=0.80)
        tracks[15]["recorded"] = True
        tracks[15]["saved_id"] = 40
        moved = box(0.86, track_id=99, label="Plastic Wrapper")
        moved["left"] = 11
        moved["top"] = 21
        adopt_existing_tracks([moved], tracks, now=1, lost_timeout_s=8)
        self.assertEqual(moved["track_id"], 15)

    def test_second_track_on_the_same_object_is_not_recorded_again(self):
        tracks: dict = {}
        first = update_tracks(tracks, [box(0.91)], now=0, min_frames=3, record_conf=0.80)
        tracks[15]["recorded"] = True
        tracks[15]["saved_id"] = 40
        second = update_tracks(tracks, [box(0.88, track_id=99)], now=1, min_frames=3, record_conf=0.80)
        self.assertTrue(second[0]["confirmed"])
        events = confirmed_events(tracks, second, {}, now=1, min_frames=3, cooldown_s=0, record_conf=0.80)
        self.assertEqual(events, [])
        self.assertTrue(tracks[99]["recorded"])
        self.assertEqual(tracks[99]["saved_id"], 40)

    def test_missed_frame_keeps_the_box_until_the_track_expires(self):
        tracks: dict = {}
        update_tracks(tracks, [box(0.91)], now=0, min_frames=3, record_conf=0.80, lost_timeout_s=3)
        update_tracks(tracks, [], now=1, min_frames=3, record_conf=0.80, lost_timeout_s=3)
        held = retain_active_overlay_boxes([], tracks, now=1, lost_timeout_s=3)
        self.assertEqual(len(held), 1)
        self.assertEqual(held[0]["track_id"], 15)
        self.assertEqual(tracks[15]["frames"], 1)
        update_tracks(tracks, [], now=5, min_frames=3, record_conf=0.80, lost_timeout_s=3)
        self.assertEqual(retain_active_overlay_boxes([], tracks, now=5, lost_timeout_s=3), [])

    def test_recorded_track_survives_longer_than_an_unconfirmed_one(self):
        tracks: dict = {}
        update_tracks(tracks, [box(0.91)], now=0, min_frames=3, record_conf=0.80, lost_timeout_s=3)
        tracks[15]["recorded"] = True
        update_tracks(tracks, [], now=5, min_frames=3, record_conf=0.80, lost_timeout_s=3)
        self.assertIn(15, tracks)
        update_tracks(tracks, [], now=9, min_frames=3, record_conf=0.80, lost_timeout_s=3)
        self.assertNotIn(15, tracks)

    def test_zoomed_bottle_is_not_dropped_for_size(self):
        kept = filter_overlay_boxes(
            [box(0.91) | {"width": 46, "height": 30, "class": "Plastic Bottle"}]
        )
        self.assertEqual(len(kept), 1)

    def test_recorded_track_is_still_returned_for_the_overlay(self):
        tracks: dict = {}
        seen = []
        for index, score in enumerate((0.91, 0.90, 0.92)):
            seen = update_tracks(tracks, [box(score)], now=index, min_frames=3, record_conf=0.80)
        tracks[15]["recorded"] = True
        later = update_tracks(tracks, [box(0.89)], now=4, min_frames=3, record_conf=0.80)
        overlay = retain_active_overlay_boxes(later, tracks, now=4, lost_timeout_s=3)
        self.assertEqual(overlay[0]["track_id"], 15)
        self.assertTrue(overlay[0]["confirmed"] or tracks[15]["recorded"])


if __name__ == "__main__":
    unittest.main()
