"""Precision/recall on labeled stills. Confidence is never treated as accuracy.

Prefers the TapoCam live-waste YOLO val split when present (class names, not
raw indices — the ONNX model has 14 classes; that dataset yaml lists 13).
Falls back to _diag/ground_truth.json. mAP50 is a VOC-style curve on that set.
mAP50-95 is omitted unless Ultralytics val is run on a matching-nc split.
"""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter, defaultdict
from pathlib import Path

import ast
import re

import cv2

import app as detector_app

ROOT = Path(__file__).resolve().parent
DIAG = ROOT / "_diag"
GT_PATH = DIAG / "ground_truth.json"
WEIGHTS = ROOT / "weights" / "trained" / "best.onnx"
FOCUS = {"Can", "Plastic Bottle", "Plastic Wrapper", "Paper Bag"}
TAPO = ROOT / "datasets" / "TapoCam-Live-Waste-Dataset"
LOCAL = ROOT / "datasets" / "local-merged"


def _iou(a: dict, b: dict) -> float:
    return detector_app._iou(a, b)


def _prf(tp: int, fp: int, fn: int) -> tuple[float | None, float | None]:
    precision = tp / (tp + fp) if (tp + fp) else None
    recall = tp / (tp + fn) if (tp + fn) else None
    return precision, recall


def _voc_ap(recalls: list[float], precisions: list[float]) -> float:
    """11-point VOC AP."""
    if not recalls:
        return 0.0
    ap = 0.0
    for threshold in [i / 10 for i in range(11)]:
        candidates = [p for r, p in zip(recalls, precisions) if r >= threshold]
        ap += max(candidates) if candidates else 0.0
    return ap / 11.0


def _load_yaml_names(data_yaml: Path) -> list[str]:
    text = data_yaml.read_text(encoding="utf-8")
    match = re.search(r"names:\s*(\[[^\]]+\])", text)
    if match:
        parsed = ast.literal_eval(match.group(1))
        return [str(item) for item in parsed]
    return list(detector_app.ONNX_CLASSES)


def _yolo_to_box(cx: float, cy: float, w: float, h: float, label: str) -> dict:
    return {
        "class": label,
        "left": (cx - w / 2.0) * 100.0,
        "top": (cy - h / 2.0) * 100.0,
        "width": w * 100.0,
        "height": h * 100.0,
    }


def load_yolo_split(dataset: Path, split: str = "valid") -> tuple[list[dict], list[str]]:
    data_yaml = dataset / "data.yaml"
    names = _load_yaml_names(data_yaml) if data_yaml.is_file() else list(detector_app.ONNX_CLASSES)
    images_dir = dataset / split / "images"
    labels_dir = dataset / split / "labels"
    rows: list[dict] = []
    if not images_dir.is_dir():
        return rows, names
    files = sorted(list(images_dir.glob("*.jpg")) + list(images_dir.glob("*.png")))
    for image_path in files:
        label_path = labels_dir / f"{image_path.stem}.txt"
        objects: list[dict] = []
        if label_path.is_file():
            for line in label_path.read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) < 5:
                    continue
                cls_id = int(float(parts[0]))
                if cls_id < 0 or cls_id >= len(names):
                    continue
                cx, cy, w, h = (float(v) for v in parts[1:5])
                objects.append(_yolo_to_box(cx, cy, w, h, names[cls_id]))
        rows.append({"file": str(image_path), "objects": objects})
    return rows, names


def load_diag_gt(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = []
    for row in payload.get("images") or []:
        image = DIAG / str(row.get("file") or "")
        if image.is_file():
            rows.append({"file": str(image), "objects": list(row.get("objects") or [])})
    return rows


def _match(pred: list[dict], truth: list[dict], iou_min: float = 0.5) -> dict:
    used: set[int] = set()
    tp = 0
    wrong = 0
    pairs: list[tuple[str, str]] = []
    matched_pred: set[int] = set()
    for p_i, box in enumerate(
        sorted(pred, key=lambda item: float(item.get("confidence") or 0), reverse=True)
    ):
        best_i = None
        best_iou = iou_min
        for index, gt in enumerate(truth):
            if index in used:
                continue
            iou = _iou(box, gt)
            if iou > best_iou:
                best_iou = iou
                best_i = index
        if best_i is None:
            continue
        used.add(best_i)
        matched_pred.add(p_i)
        gt_cls = str(truth[best_i]["class"])
        pred_cls = str(box.get("class") or "")
        pairs.append((gt_cls, pred_cls))
        if pred_cls == gt_cls:
            tp += 1
        else:
            wrong += 1
    fp = len(pred) - len(matched_pred)
    fn = len(truth) - len(used)
    return {
        "tp": tp,
        "fp": max(0, fp),
        "fn": fn,
        "wrong": wrong,
        "pairs": pairs,
        "missed": [truth[i]["class"] for i in range(len(truth)) if i not in used],
    }


def _class_ap(hits: list[tuple[float, bool]], n_gt: int) -> float:
    """hits: (confidence, is_tp) for one class, already matched within each image."""
    if n_gt <= 0:
        return 0.0
    ranked = sorted(hits, key=lambda item: item[0], reverse=True)
    tp_run = 0
    fp_run = 0
    recs: list[float] = []
    precs: list[float] = []
    for _conf, is_tp in ranked:
        if is_tp:
            tp_run += 1
        else:
            fp_run += 1
        recs.append(tp_run / n_gt)
        precs.append(tp_run / (tp_run + fp_run))
    return _voc_ap(recs, precs)


def _run(model, names, image, mode: str, remap: bool, conf: float) -> list[dict]:
    detector_app.settings.class_identity_remap = remap
    return detector_app.predict_frame_boxes(
        model,
        image,
        conf,
        names,
        iou=detector_app.settings.iou,
        mode=mode,
    )


def evaluate(rows: list[dict], model, names, mode: str, remap: bool, conf: float, limit: int | None):
    totals = Counter()
    per_class = defaultdict(lambda: Counter())
    confusion = Counter()
    ap_hits: dict[str, list[tuple[float, bool]]] = defaultdict(list)
    n_infer = 0
    t0 = time.perf_counter()
    selected = rows[:limit] if limit else rows
    for row in selected:
        image = cv2.imread(str(row["file"]))
        if image is None:
            continue
        n_infer += 1
        pred = _run(model, names, image, mode, remap, conf)
        truth = list(row.get("objects") or [])
        matched = _match(pred, truth)
        for field in ("tp", "fp", "fn", "wrong"):
            totals[field] += matched[field]
        for gt_cls, pred_cls in matched["pairs"]:
            per_class[gt_cls]["gt"] += 1
            if gt_cls == pred_cls:
                per_class[gt_cls]["tp"] += 1
            else:
                per_class[gt_cls]["wrong"] += 1
                confusion[(gt_cls, pred_cls)] += 1
        for missed in matched["missed"]:
            per_class[str(missed)]["gt"] += 1
            per_class[str(missed)]["fn"] += 1
        by_label_gt = defaultdict(list)
        for gt in truth:
            by_label_gt[str(gt.get("class") or "")].append(gt)
        for label, targets in by_label_gt.items():
            used = [False] * len(targets)
            ranked = sorted(
                [box for box in pred if str(box.get("class") or "") == label],
                key=lambda item: float(item.get("confidence") or 0),
                reverse=True,
            )
            for box in ranked:
                best = None
                best_iou = 0.5
                for index, gt in enumerate(targets):
                    if used[index]:
                        continue
                    iou = _iou(box, gt)
                    if iou > best_iou:
                        best_iou = iou
                        best = index
                if best is None:
                    ap_hits[label].append((float(box.get("confidence") or 0), False))
                else:
                    used[best] = True
                    ap_hits[label].append((float(box.get("confidence") or 0), True))
            for box in pred:
                pred_cls = str(box.get("class") or "")
                if pred_cls not in by_label_gt:
                    ap_hits[pred_cls].append((float(box.get("confidence") or 0), False))
    elapsed = time.perf_counter() - t0
    precision, recall = _prf(totals["tp"], totals["fp"], totals["fn"])
    labels = sorted(set(per_class) | set(FOCUS) | set(ap_hits))
    class_rows = {}
    aps = []
    for label in labels:
        counts = per_class[label]
        gt_n = counts["gt"]
        class_rows[label] = {
            "gt": gt_n,
            "tp": counts["tp"],
            "wrong": counts["wrong"],
            "fn": counts["fn"],
            "recall": None if gt_n == 0 else round(counts["tp"] / gt_n, 3),
        }
        if gt_n:
            aps.append(_class_ap(ap_hits.get(label, []), gt_n))
    mean_ms = (elapsed * 1000 / n_infer) if n_infer else None
    map50 = round(sum(aps) / len(aps), 3) if aps else None
    return {
        "n_images": n_infer,
        "totals": dict(totals),
        "precision": None if precision is None else round(precision, 3),
        "recall": None if recall is None else round(recall, 3),
        "map50": map50,
        "map50_95": None,
        "per_class": class_rows,
        "confusion": [
            {"truth": a, "pred": b, "count": n} for (a, b), n in confusion.most_common(12)
        ],
        "mean_ms": None if mean_ms is None else round(mean_ms, 1),
        "fps": None if not mean_ms else round(1000.0 / mean_ms, 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate detector on labeled stills")
    parser.add_argument("--gt", type=Path, default=GT_PATH)
    parser.add_argument("--dataset", type=Path, default=None)
    parser.add_argument("--split", default="valid")
    parser.add_argument("--mode", default="tiles_2x2")
    parser.add_argument("--conf", type=float, default=None)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--out", type=Path, default=DIAG / "eval_report.json")
    args = parser.parse_args()
    conf = float(args.conf if args.conf is not None else detector_app.settings.proposal_conf)
    limit = args.limit or None

    dataset = args.dataset
    source = "diag"
    rows: list[dict] = []
    if dataset is None:
        if (TAPO / "data.yaml").is_file():
            dataset = TAPO
        elif (LOCAL / "data.yaml").is_file():
            dataset = LOCAL
    if dataset is not None and (dataset / args.split / "images").is_dir():
        rows, yaml_names = load_yolo_split(dataset, args.split)
        source = str(dataset)
        print(f"[eval] YOLO split {dataset.name}/{args.split}: {len(rows)} images, {len(yaml_names)} names")
        print("[eval] matching by class name (ONNX has 14 classes; yaml may list 13).")
    else:
        rows = load_diag_gt(args.gt)
        print(f"[eval] diagnostic stills only ({len(rows)} images) — not publishable mAP.")

    if not rows:
        raise SystemExit("no labeled images found")
    if not WEIGHTS.is_file():
        raise SystemExit(f"missing ONNX weights: {WEIGHTS}")

    from ultralytics import YOLO

    model = YOLO(str(WEIGHTS), task="detect")
    names = detector_app.resolve_model_classes(model)
    summary = {
        "note": (
            "TapoCam/local-merged val uses class names. "
            "mAP50-95 omitted: yaml nc=13 vs ONNX nc=14, so Ultralytics index val would be wrong."
        ),
        "source": source,
        "mode": args.mode,
        "conf": conf,
        "limit": limit,
        "remap": {},
        "focus_classes": sorted(FOCUS),
        "diag": None,
    }

    for remap in (False, True):
        key = "on" if remap else "off"
        result = evaluate(rows, model, names, args.mode, remap, conf, limit)
        summary["remap"][key] = result
        print(
            f"[eval] remap={key} P={result['precision']} R={result['recall']} "
            f"mAP50={result['map50']} tp={result['totals'].get('tp')} "
            f"fp={result['totals'].get('fp')} fn={result['totals'].get('fn')} "
            f"wrong={result['totals'].get('wrong')} {result['mean_ms']}ms "
            f"({result['n_images']} images)"
        )
        for label in sorted(FOCUS):
            row = result["per_class"].get(label)
            if row and row["gt"]:
                print(f"        {label}: {row}")
        if result["confusion"]:
            print(f"        confusion: {result['confusion'][:6]}")

    if args.gt.is_file() and source != "diag":
        diag_rows = load_diag_gt(args.gt)
        if diag_rows:
            summary["diag"] = evaluate(
                diag_rows, model, names, args.mode, False, conf, None
            )
            print(
                f"[eval] diag stills remap=off P={summary['diag']['precision']} "
                f"R={summary['diag']['recall']} (tiny HUD captures, not mAP)"
            )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"[eval] wrote {args.out}")


if __name__ == "__main__":
    main()
