"""Offline timing + class-map bench for the live YOLOv11 ONNX detector.

Runs the same predict/track path as app.py on saved frames. Does not talk to
the camera, Laravel, or Roboflow. Writes JSON next to the script by default.
"""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from pathlib import Path

import cv2

import app as detector_app
from streams import new_byte_tracker

ROOT = Path(__file__).resolve().parent
DIAG = ROOT / "_diag"
WEIGHTS = ROOT / "weights" / "trained" / "best.onnx"
DEFAULT_FRAMES = [
    DIAG / "cam-01_ok.jpg",
    DIAG / "cam-02_ok.jpg",
    DIAG / "cam01.jpg",
    DIAG / "cam02.jpg",
]
MODES = ("full_frame", "tiles_2x2", "full_plus_tiles")


def _histogram(boxes: list[dict]) -> dict[str, int]:
    return dict(Counter(str(box.get("class") or "") for box in boxes))


def _providers() -> list[str]:
    return detector_app.onnx_runtime_providers()


def _load_model():
    if not WEIGHTS.is_file():
        raise SystemExit(f"missing ONNX weights: {WEIGHTS}")
    from ultralytics import YOLO

    model = YOLO(str(WEIGHTS), task="detect")
    names = detector_app.resolve_model_classes(model)
    return model, names


def _class_audit(model) -> dict:
    names = getattr(model, "names", None) or {}
    if isinstance(names, dict):
        ordered = [str(names[i]) for i in range(len(names))]
    else:
        ordered = [str(item) for item in list(names)]
    mapped = detector_app.resolve_model_classes(model)
    mismatches = [
        {"index": i, "onnx": raw, "canonical": mapped[i] if i < len(mapped) else None}
        for i, raw in enumerate(ordered)
        if i >= len(detector_app.ONNX_CLASSES)
        or detector_app.canonical_waste_class(raw) != detector_app.ONNX_CLASSES[i]
    ]
    return {
        "onnx_raw": ordered,
        "canonical": mapped,
        "official": list(detector_app.ONNX_CLASSES),
        "count_ok": len(ordered) == len(detector_app.ONNX_CLASSES),
        "mismatches": mismatches,
        "providers": _providers(),
        "cuda": "CUDAExecutionProvider" in _providers(),
    }


def _run_frame(model, names, frame, mode: str, remap: bool, conf: float) -> dict:
    detector_app.settings.class_identity_remap = remap
    timing: dict = {}
    t0 = time.perf_counter()
    tracker = new_byte_tracker()
    boxes = detector_app.track_frame_boxes(
        model,
        frame,
        conf,
        detector_app.settings.iou,
        names,
        tracker=tracker,
        mode=mode,
        timing=timing,
    )
    total_ms = (time.perf_counter() - t0) * 1000
    timing["total_ms"] = round(total_ms, 1)
    return {
        "timing": timing,
        "n_boxes": len(boxes),
        "classes": _histogram(boxes),
        "boxes": [
            {
                "class": box.get("class"),
                "confidence": box.get("confidence"),
                "left": box.get("left"),
                "top": box.get("top"),
                "width": box.get("width"),
                "height": box.get("height"),
                "track_id": box.get("track_id"),
            }
            for box in boxes
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Bench live detector on saved frames")
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--out", type=Path, default=DIAG / "bench_baseline.json")
    parser.add_argument("--conf", type=float, default=None)
    args = parser.parse_args()
    conf = float(args.conf if args.conf is not None else detector_app.settings.proposal_conf)

    frames = [path for path in DEFAULT_FRAMES if path.is_file()]
    if not frames:
        raise SystemExit(f"no diag frames in {DIAG}")

    print(f"[bench] loading {WEIGHTS}")
    model, names = _load_model()
    audit = _class_audit(model)
    print(f"[bench] classes ({len(audit['canonical'])}): {audit['canonical']}")
    print(f"[bench] providers: {audit['providers']}")
    if audit["mismatches"]:
        print(f"[bench] CLASS MISMATCH: {audit['mismatches']}")
    elif not audit["count_ok"]:
        print("[bench] CLASS COUNT MISMATCH versus ONNX_CLASSES")
    else:
        print("[bench] class index order matches ONNX_CLASSES")

    decode: dict[str, float] = {}
    loaded: dict[str, object] = {}
    for path in frames:
        t0 = time.perf_counter()
        image = cv2.imread(str(path))
        decode[path.name] = round((time.perf_counter() - t0) * 1000, 1)
        if image is None:
            print(f"[bench] skip unreadable {path.name}")
            continue
        loaded[path.name] = image
        print(f"[bench] {path.name} {image.shape[1]}x{image.shape[0]} decode={decode[path.name]}ms")

    report: dict = {
        "weights": str(WEIGHTS),
        "class_audit": audit,
        "conf": conf,
        "decode_ms": decode,
        "modes": {},
        "remap": {},
    }

    for mode in MODES:
        mode_rows = []
        for name, image in loaded.items():
            for _ in range(max(0, args.warmup)):
                _run_frame(model, names, image, mode, False, conf)
            timed = [
                _run_frame(model, names, image, mode, False, conf)
                for _ in range(max(1, args.runs))
            ]
            totals = [row["timing"]["total_ms"] for row in timed]
            mean_ms = sum(totals) / len(totals)
            last = timed[-1]
            mode_rows.append(
                {
                    "file": name,
                    "mean_ms": round(mean_ms, 1),
                    "fps": round(1000.0 / mean_ms, 2) if mean_ms else None,
                    "n_regions": last["timing"].get("n_regions"),
                    "crop_ms": last["timing"].get("crop_ms"),
                    "predict_ms": last["timing"].get("predict_ms"),
                    "refine_ms": last["timing"].get("refine_ms"),
                    "track_ms": last["timing"].get("track_ms"),
                    "n_boxes": last["n_boxes"],
                    "classes": last["classes"],
                    "boxes": last["boxes"],
                }
            )
            print(
                f"[bench] {mode:16} {name:18} "
                f"{mean_ms:7.1f}ms  boxes={last['n_boxes']}  {last['classes']}"
            )
        report["modes"][mode] = mode_rows

    # Raw vs identity-remap on the default live mode, same frames.
    live_mode = detector_app.detection_mode()
    for remap in (False, True):
        key = "on" if remap else "off"
        rows = []
        for name, image in loaded.items():
            result = _run_frame(model, names, image, live_mode, remap, conf)
            rows.append(
                {
                    "file": name,
                    "n_boxes": result["n_boxes"],
                    "classes": result["classes"],
                    "boxes": result["boxes"],
                }
            )
            print(f"[bench] remap={key:3} {name:18} {result['classes']}")
        report["remap"][key] = rows

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"[bench] wrote {args.out}")


if __name__ == "__main__":
    main()
