"""
Download your Roboflow *datasets* (the labels you annotated) and train
YOLOv8 locally. No Roboflow credits. The cloud .pt is locked on this plan;
this uses the same annotations on your PC.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from dotenv import load_dotenv
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent
CATALOG = ROOT / "roboflow_datasets.json"
DATASETS = ROOT / "datasets"
WEIGHTS_OUT = ROOT / "weights" / "trained" / "best.pt"
PRETRAINED = ROOT / "yolov8n.pt"

# Train the set you annotated most (LOCAL DATASET). Others are downloaded for backup.
PRIMARY = "local-dataset-q7yfq"


def model_ids() -> list[str]:
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    ids: list[str] = []
    for group in ("existing", "new"):
        for row in data.get(group) or []:
            mid = str(row.get("model_id") or "")
            if mid:
                ids.append(mid)
    return ids


def download_all(api_key: str, workspace: str) -> None:
    from roboflow import Roboflow

    rf = Roboflow(api_key=api_key)
    ws = rf.workspace(workspace)
    DATASETS.mkdir(parents=True, exist_ok=True)
    for mid in model_ids():
        slug, _, ver = mid.partition("/")
        dest = DATASETS / slug
        if (dest / "data.yaml").is_file():
            print(f"[skip] {slug} already downloaded")
            continue
        print(f"[download] {mid} → {dest}")
        try:
            ws.project(slug).version(int(ver)).download("yolov8", location=str(dest))
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] {mid}: {exc}")


def train_primary() -> Path | None:
    yaml_path = DATASETS / PRIMARY / "data.yaml"
    if not yaml_path.is_file():
        print(f"[train] missing {yaml_path}")
        return None
    base = str(PRETRAINED) if PRETRAINED.is_file() else "yolov8n.pt"
    print(f"[train] {PRIMARY} from {base} (CPU — leave this window open)")
    model = YOLO(base)
    model.train(
        data=str(yaml_path),
        epochs=40,
        imgsz=640,
        batch=8,
        device="cpu",
        workers=0,
        patience=12,
        project=str(ROOT / "runs"),
        name="rf-local",
        exist_ok=True,
        pretrained=True,
        verbose=True,
    )
    best = ROOT / "runs" / "rf-local" / "weights" / "best.pt"
    if not best.is_file():
        print("[train] best.pt not found")
        return None
    WEIGHTS_OUT.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best, WEIGHTS_OUT)
    print(f"[train] copied {WEIGHTS_OUT}")
    return WEIGHTS_OUT


def main() -> None:
    load_dotenv(ROOT / ".env")
    key = os.getenv("ROBOFLOW_API_KEY") or ""
    workspace = os.getenv("ROBOFLOW_WORKSPACE") or "ejems-workspace"
    if not key:
        raise SystemExit("ROBOFLOW_API_KEY missing in detector/.env")
    download_all(key, workspace)
    train_primary()


if __name__ == "__main__":
    main()
