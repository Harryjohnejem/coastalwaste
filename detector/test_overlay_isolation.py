"""Overlay must never return another camera's publish state."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import app as detector_app
from streams import StreamPublishState


class OverlayIsolationTests(unittest.TestCase):
    def setUp(self):
        # Class rules are tested with every class on; .env exclusions are tested below.
        excluded = patch.object(detector_app.settings, "excluded_classes", "")
        excluded.start()
        self.addCleanup(excluded.stop)

    def test_excluded_classes_are_dropped_from_live_and_review(self):
        detector_app.settings.excluded_classes = "Cardboard,Paper Drink Carton,Paper Bag"
        review: list = []
        boxes = detector_app.apply_class_refinement(
            [
                {"class": "Cardboard", "confidence": 0.9, "left": 10, "top": 10, "width": 6, "height": 6},
                {"class": "paper bag", "confidence": 0.75, "left": 30, "top": 30, "width": 6, "height": 6},
                {"class": "Paper Drink Carton", "confidence": 0.9, "left": 50, "top": 50, "width": 6, "height": 6},
                {"class": "Plastic Bottle", "confidence": 0.9, "left": 70, "top": 70, "width": 6, "height": 6},
            ],
            review,
        )
        self.assertEqual([b["class"] for b in boxes], ["Plastic Bottle"])
        self.assertEqual(review, [])
        names = ["Can", "Cardboard", "Ecobag", "Paper Bag", "Paper Drink Carton", "Plastic Bottle"]
        self.assertEqual(detector_app.allowed_class_ids(names), [0, 2, 5])

    def test_no_exclusions_keeps_every_class_id(self):
        self.assertIsNone(detector_app.allowed_class_ids(["Can", "Cardboard"]))
    def test_missing_stream_returns_none_not_sibling(self):
        cam01 = StreamPublishState(ready=True, last_boxes=[{"class": "Can", "camera_id": "CAM-01"}])
        with patch.object(detector_app, "_stream_states", {"CAM-01": cam01}):
            cam, publish = detector_app._get_stream_publish("CAM-02")
        self.assertEqual(cam, "CAM-02")
        self.assertIsNone(publish)

    def test_known_stream_returns_own_state(self):
        cam02 = StreamPublishState(ready=True, last_boxes=[{"class": "Ecobag", "camera_id": "CAM-02"}])
        with patch.object(
            detector_app,
            "_stream_states",
            {"CAM-01": StreamPublishState(), "CAM-02": cam02},
        ):
            cam, publish = detector_app._get_stream_publish("CAM-02")
        self.assertEqual(cam, "CAM-02")
        self.assertIs(publish, cam02)
        self.assertEqual(publish.last_boxes[0]["class"], "Ecobag")

    def test_overlay_payload_includes_motion_flag(self):
        st = StreamPublishState(
            motion={"has_motion": True, "region_count": 2},
            last_boxes=[{"class": "Can", "motion": True}],
            hud_conf=0.2,
        )
        payload = st.overlay_payload("CAM-01", "test")
        self.assertTrue(payload["motion_active"])
        self.assertEqual(payload["camera_id"], "CAM-01")
        self.assertEqual(payload["boxes"][0]["motion"], True)
        self.assertEqual(payload["hud_conf"], 0.2)

    def test_boxes_below_70_are_dropped(self):
        live = {
            "confidence": 0.80,
            "record_conf": 0.80,
            "classes": set(detector_app.ONNX_CLASSES),
        }
        floor = detector_app._overlay_confidence_floor(live)
        self.assertAlmostEqual(floor, 0.80, places=2)
        kept = detector_app._apply_detection_settings(
            [
                {"class": "Plastic Cup", "confidence": 0.28, "camera_id": "CAM-02"},
                {"class": "Plastic Bottle", "confidence": 0.82, "camera_id": "CAM-02"},
            ],
            live,
            include_provisional=False,
        )
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["class"], "Plastic Bottle")
        outside = detector_app._apply_detection_settings(
            [
                {"class": "Can", "confidence": 0.75, "camera_id": "CAM-02"},
                {"class": "Can", "confidence": 0.99, "camera_id": "CAM-02"},
                {"class": "Can", "confidence": 0.91, "camera_id": "CAM-02"},
            ],
            live,
        )
        self.assertEqual([box["confidence"] for box in outside], [0.91])

    def test_proposal_boxes_are_marked_provisional(self):
        live = {
            "confidence": 0.80,
            "record_conf": 0.80,
            "classes": set(detector_app.ONNX_CLASSES),
        }
        kept = detector_app._apply_detection_settings(
            [
                {"class": "Can", "confidence": 0.42, "camera_id": "CAM-01"},
                {"class": "Plastic Bottle", "confidence": 0.88, "camera_id": "CAM-01"},
            ],
            live,
            include_provisional=True,
        )
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["class"], "Plastic Bottle")
        self.assertFalse(kept[0]["provisional"])

    def test_floor_never_below_70(self):
        floor = detector_app._overlay_confidence_floor(
            {"confidence": 0.20, "record_conf": 0.20}
        )
        self.assertGreaterEqual(floor, detector_app.MIN_DETECT_CONF)

    def test_unfamiliar_prompts_stay_outside_the_cctv_model(self):
        official = {detector_app._norm_class(name) for name in detector_app.ONNX_CLASSES}
        prompts = detector_app.unfamiliar_prompts()
        self.assertIn("plastic bag", prompts)
        for prompt in prompts:
            self.assertNotIn(detector_app._norm_class(prompt), official)

    def test_dataset_classes_stay_eligible(self):
        allowed = detector_app._hud_allowed_classes({"classes": {"Can"}})
        self.assertIn("Can", allowed)
        self.assertIn("Plastic Bottle", allowed)
        self.assertIn("Ecobag", allowed)

    def test_canonical_maps_dataset_aliases(self):
        self.assertEqual(detector_app.canonical_waste_class("plastic-bottle"), "Plastic Bottle")
        self.assertEqual(detector_app.canonical_waste_class("Face Mask"), "Face Mask")
        self.assertEqual(detector_app.canonical_waste_class("styrofoam cup"), "Styro Cup")
        self.assertEqual(detector_app.canonical_waste_class("eco bag"), "Ecobag")
        self.assertIsNone(detector_app.canonical_waste_class("person"))

    def test_dataset_class_is_never_unlabeled(self):
        boxes = [{"class": "plastic bottle", "confidence": 0.72, "track_id": 4}]
        detector_app.update_tracks({}, boxes, 1.0, 3, 0.8, 3.0)
        self.assertFalse(boxes[0]["needs_label"])
        self.assertEqual(boxes[0]["class"], "Plastic Bottle")

    def test_weak_wrapper_is_dropped(self):
        label = detector_app.refine_waste_class(
            {
                "class": "Plastic Wrapper",
                "confidence": 0.74,
                "width": 8.0,
                "height": 15.2,
            }
        )
        self.assertIsNone(label)

    def test_weak_official_class_stays_on_the_hud(self):
        review = []
        boxes = detector_app.apply_class_refinement(
            [
                {
                    "class": "Plastic Wrapper",
                    "confidence": 0.74,
                    "width": 8.0,
                    "height": 15.2,
                    "left": 40.0,
                    "top": 40.0,
                    "camera_id": "CAM-03",
                }
            ],
            review_out=review,
        )
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0]["class"], "Plastic Wrapper")
        self.assertTrue(boxes[0]["provisional"])
        self.assertEqual(len(review), 1)

    def test_overlap_keeps_higher_confidence_cardboard(self):
        boxes = detector_app.apply_class_refinement(
            [
                {
                    "class": "Cardboard",
                    "confidence": 0.83,
                    "left": 71.0,
                    "top": 65.0,
                    "width": 7.9,
                    "height": 14.3,
                },
                {
                    "class": "Plastic Wrapper",
                    "confidence": 0.82,
                    "left": 71.0,
                    "top": 65.2,
                    "width": 7.8,
                    "height": 14.3,
                },
            ]
        )
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0]["class"], "Cardboard")

    def test_small_ecobag_keeps_model_name(self):
        label = detector_app.refine_waste_class(
            {
                "class": "Ecobag",
                "confidence": 0.88,
                "width": 9.0,
                "height": 12.0,
            }
        )
        self.assertEqual(label, "Ecobag")
        with patch.object(detector_app.settings, "class_identity_remap", True):
            remapped = detector_app.refine_waste_class(
                {
                    "class": "Ecobag",
                    "confidence": 0.88,
                    "width": 9.0,
                    "height": 12.0,
                }
            )
        self.assertEqual(remapped, "Plastic Wrapper")

    def test_large_ecobag_stays_ecobag(self):
        label = detector_app.refine_waste_class(
            {
                "class": "Ecobag",
                "confidence": 0.88,
                "width": 28.0,
                "height": 40.0,
            }
        )
        self.assertEqual(label, "Ecobag")

    def test_overlap_keeps_higher_confidence_wrapper(self):
        boxes = detector_app.apply_class_refinement(
            [
                {
                    "class": "Ecobag",
                    "confidence": 0.81,
                    "left": 40.0,
                    "top": 40.0,
                    "width": 20.0,
                    "height": 26.0,
                },
                {
                    "class": "Plastic Wrapper",
                    "confidence": 0.90,
                    "left": 40.2,
                    "top": 40.1,
                    "width": 20.0,
                    "height": 26.0,
                },
            ]
        )
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0]["class"], "Plastic Wrapper")

    def test_confident_wrapper_is_kept(self):
        label = detector_app.refine_waste_class(
            {
                "class": "Plastic Wrapper",
                "confidence": 0.86,
                "width": 8.0,
                "height": 15.2,
            }
        )
        self.assertEqual(label, "Plastic Wrapper")

    def test_boxy_bottle_stays_bottle_without_remap(self):
        with patch.object(detector_app.settings, "class_identity_remap", False):
            label = detector_app.refine_waste_class(
                {
                    "class": "Plastic Bottle",
                    "confidence": 0.77,
                    "width": 7.3,
                    "height": 17.8,
                }
            )
        self.assertEqual(label, "Plastic Bottle")

    def test_boxy_bottle_becomes_drink_carton_when_remap_on(self):
        with patch.object(detector_app.settings, "class_identity_remap", True):
            label = detector_app.refine_waste_class(
                {
                    "class": "Plastic Bottle",
                    "confidence": 0.77,
                    "width": 7.3,
                    "height": 17.8,
                }
            )
        self.assertEqual(label, "Paper Drink Carton")

    def test_rectangular_foam_becomes_cardboard(self):
        with patch.object(detector_app.settings, "class_identity_remap", True):
            label = detector_app.refine_waste_class(
                {
                    "class": "Styrofoam",
                    "confidence": 0.78,
                    "width": 10.7,
                    "height": 10.6,
                }
            )
        self.assertEqual(label, "Cardboard")

    def test_tall_cardboard_becomes_wrapper(self):
        with patch.object(detector_app.settings, "class_identity_remap", True):
            label = detector_app.refine_waste_class(
                {
                    "class": "Cardboard",
                    "confidence": 0.81,
                    "width": 7.9,
                    "height": 14.2,
                }
            )
        self.assertEqual(label, "Plastic Wrapper")

    def test_one_frame_does_not_rename_the_track(self):
        tracks = {}
        first = [
            {
                "class": "Cardboard",
                "confidence": 0.83,
                "track_id": 9,
                "left": 71,
                "top": 65,
                "width": 8,
                "height": 14,
            }
        ]
        detector_app.update_tracks(tracks, first, 1.0, 3, 0.8, 3.0)
        second = [
            {
                "class": "Plastic Wrapper",
                "confidence": 0.80,
                "track_id": 9,
                "left": 71,
                "top": 65,
                "width": 8,
                "height": 14,
            }
        ]
        detector_app.update_tracks(tracks, second, 2.0, 3, 0.8, 3.0)
        self.assertEqual(second[0]["class"], "Cardboard")

    def test_skinny_bag_is_dropped(self):
        label = detector_app.refine_waste_class(
            {
                "class": "Ecobag",
                "confidence": 0.73,
                "width": 8.7,
                "height": 31.4,
            }
        )
        self.assertIsNone(label)

    def test_overlap_keeps_stronger_wrapper_over_bottle(self):
        boxes = detector_app.apply_class_refinement(
            [
                {
                    "class": "Plastic Wrapper",
                    "confidence": 0.86,
                    "left": 64.0,
                    "top": 32.0,
                    "width": 5.0,
                    "height": 14.0,
                },
                {
                    "class": "Plastic Bottle",
                    "confidence": 0.84,
                    "left": 65.0,
                    "top": 33.0,
                    "width": 5.1,
                    "height": 14.4,
                },
            ]
        )
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0]["class"], "Plastic Wrapper")

    def test_track_keeps_stable_class(self):
        tracks = {}
        first = [
            {
                "class": "Plastic Bottle",
                "confidence": 0.85,
                "track_id": 8,
                "left": 60,
                "top": 30,
                "width": 7,
                "height": 16,
            }
        ]
        detector_app.update_tracks(tracks, first, 1.0, 3, 0.8, 3.0)
        second = [
            {
                "class": "Plastic Wrapper",
                "confidence": 0.79,
                "track_id": 8,
                "left": 60,
                "top": 30,
                "width": 7,
                "height": 16,
            }
        ]
        detector_app.update_tracks(tracks, second, 2.0, 3, 0.8, 3.0)
        self.assertEqual(second[0]["class"], "Plastic Bottle")

    def test_overlapping_tile_boxes_kept_once(self):
        boxes = detector_app.apply_class_refinement(
            [
                {
                    "class": "Can",
                    "confidence": 0.91,
                    "left": 47.2,
                    "top": 40.0,
                    "width": 6.4,
                    "height": 8.1,
                },
                {
                    "class": "Can",
                    "confidence": 0.84,
                    "left": 47.8,
                    "top": 40.4,
                    "width": 6.2,
                    "height": 8.0,
                },
            ]
        )
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0]["class"], "Can")

    def test_full_plus_tiles_has_five_wide_regions(self):
        regions = detector_app.inference_regions(2304, 1296, "full_plus_tiles")
        self.assertEqual(len(regions), 5)
        self.assertEqual(regions[0], (0, 0, 2304, 1296))
        self.assertEqual(len(detector_app.inference_regions(2304, 1296, "tiles_2x2")), 4)
        self.assertEqual(len(detector_app.inference_regions(2304, 1296, "full_frame")), 1)
        self.assertEqual(len(detector_app.inference_regions(640, 480, "tiles_2x2")), 1)

    def test_two_strip_alias_is_full_plus_tiles(self):
        self.assertEqual(detector_app.detection_mode("two_strip"), "full_plus_tiles")
        self.assertEqual(detector_app.stream_detection_mode("cam02"), detector_app.stream_detection_mode("cam01"))
        self.assertEqual(detector_app.stream_detection_mode("cam04"), "full_frame")

    def test_resolve_model_classes_keeps_model_order_on_count_mismatch(self):
        class Fake:
            names = {0: "Can", 1: "Cardboard"}

        mapped = detector_app.resolve_model_classes(Fake())
        self.assertEqual(mapped, ["Can", "Cardboard"])

    def test_majority_vote_allows_equal_priority_switch(self):
        tracks = {}
        box = {
            "class": "Plastic Wrapper",
            "confidence": 0.80,
            "track_id": 4,
            "left": 50,
            "top": 40,
            "width": 8,
            "height": 10,
        }
        detector_app.update_tracks(tracks, [dict(box)], 1.0, 3, 0.8, 3.0)
        later = dict(box)
        later["class"] = "Plastic Cellophane"
        later["confidence"] = 0.81
        detector_app.update_tracks(tracks, [later], 2.0, 3, 0.8, 3.0)
        self.assertEqual(later["class"], "Plastic Wrapper")
        for tick in (3.0, 4.0, 5.0):
            again = dict(box)
            again["class"] = "Plastic Cellophane"
            again["confidence"] = 0.81
            detector_app.update_tracks(tracks, [again], tick, 3, 0.8, 3.0)
        self.assertEqual(again["class"], "Plastic Cellophane")

    def test_person_shaped_box_is_not_a_waste_detection(self):
        person = {"class": "Face Mask", "confidence": 0.91, "width": 22, "height": 48}
        bottle = {"class": "Plastic Bottle", "confidence": 0.9, "width": 8, "height": 18}
        mask = {"class": "Face Mask", "confidence": 0.9, "width": 6, "height": 8}
        self.assertTrue(detector_app.is_person_sized(person))
        self.assertFalse(detector_app.is_person_sized(bottle))
        self.assertFalse(detector_app.is_person_sized(mask))
        telephoto = {"class": "Plastic Bottle", "confidence": 0.9, "width": 30, "height": 40}
        self.assertFalse(detector_app.is_person_sized(telephoto))
        zoomed = {"class": "Plastic Bottle", "confidence": 0.91, "width": 28, "height": 62}
        self.assertFalse(detector_app.is_person_sized(zoomed))
        standing = {"class": "Plastic Bottle", "confidence": 0.91, "width": 24, "height": 78}
        self.assertTrue(detector_app.is_person_sized(standing))
        kept = detector_app.filter_overlay_boxes([person, bottle, mask])
        self.assertEqual([box["class"] for box in kept], ["Plastic Bottle", "Face Mask"])

    def test_unfamiliar_prompts_include_non_waste_objects(self):
        prompts = detector_app.unfamiliar_prompts()
        self.assertIn("electrical plug", prompts)
        self.assertIn("charger", prompts)
        for prompt in prompts:
            self.assertNotIn(
                detector_app._norm_class(prompt),
                {detector_app._norm_class(name) for name in detector_app.ONNX_CLASSES},
            )

    def test_overlapping_unfamiliar_object_is_not_saved_as_waste(self):
        waste = {"class": "Face Mask", "left": 10, "top": 10, "width": 30, "height": 40}
        plug = {
            "label": "electrical plug",
            "confidence": 0.86,
            "x": 0.12,
            "y": 0.12,
            "width": 0.28,
            "height": 0.36,
        }
        outside, disputes = detector_app.split_unfamiliar([plug], [waste])
        self.assertEqual(outside, [])
        self.assertEqual(disputes, [plug])
        pending = {7: {"class": "Face Mask", "confidence": 0.80, **{k: waste[k] for k in ("left", "top", "width", "height")}}}
        dropped = detector_app.drop_disputed_saves(pending, disputes)
        self.assertEqual(list(pending), [])
        self.assertEqual(dropped[0][0], 7)
        self.assertEqual(dropped[0][2]["label"], "electrical plug")

    def test_weaker_unfamiliar_guess_does_not_drop_a_waste_save(self):
        waste = {"class": "Face Mask", "left": 10, "top": 10, "width": 30, "height": 40}
        plug = {
            "label": "charger",
            "confidence": 0.72,
            "x": 0.12,
            "y": 0.12,
            "width": 0.28,
            "height": 0.36,
        }
        pending = {7: {"class": "Face Mask", "confidence": 0.80, "left": 10, "top": 10, "width": 30, "height": 40}}
        _outside, disputes = detector_app.split_unfamiliar([plug], [waste])
        dropped = detector_app.drop_disputed_saves(pending, disputes)
        self.assertEqual(dropped, [])
        self.assertIn(7, pending)

    def test_unfamiliar_object_away_from_waste_stays_out_of_saves(self):
        waste = {"class": "Can", "left": 0, "top": 0, "width": 10, "height": 10}
        shoe = {
            "label": "shoe",
            "confidence": 0.91,
            "x": 0.60,
            "y": 0.60,
            "width": 0.20,
            "height": 0.20,
        }
        outside, disputes = detector_app.split_unfamiliar([shoe], [waste])
        self.assertEqual(disputes, [])
        self.assertEqual(outside[0]["label"], "shoe")
        pending = {3: {"class": "Can", "confidence": 0.90, "left": 0, "top": 0, "width": 10, "height": 10}}
        self.assertEqual(detector_app.drop_disputed_saves(pending, disputes), [])
        self.assertIn(3, pending)

    def test_low_confidence_known_class_is_not_queued_for_review(self):
        live = {
            "confidence": 0.80,
            "record_conf": 0.80,
            "review_conf": 0.50,
            "classes": set(detector_app.ONNX_CLASSES),
        }
        boxes = [
            {"class": "Can", "confidence": 0.42, "camera_id": "CAM-01"},
            {"class": "Can", "confidence": 0.62, "camera_id": "CAM-01"},
            {"class": "Plastic Bottle", "confidence": 0.88, "camera_id": "CAM-01"},
            {"class": "Ecobag", "confidence": 0.99, "camera_id": "CAM-01"},
        ]
        kept = detector_app._apply_detection_settings(boxes, live)
        review = detector_app._low_confidence_review_boxes(boxes, live)
        self.assertEqual([box["class"] for box in kept], ["Plastic Bottle"])
        self.assertEqual(review, [])


if __name__ == "__main__":
    unittest.main()
