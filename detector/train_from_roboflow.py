"""
Download Roboflow datasets listed in the catalog (all groups, per-workspace)
and optionally train a single-dataset model. For the 8-dataset merge used in
live detection, run merge_train_expand8.py instead.
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
FALLBACK_WORKSPACES = ("ejems-workspace", "dioquino-jims-carl-k")


def catalog_download_rows() -> list[tuple[str, int, str]]:
    """Return (slug, version, workspace) from catalog / env."""
    env_ids = [x.strip() for x in (os.getenv("ROBOFLOW_MODEL_IDS") or "").split(",") if x.strip()]
    default_ws = os.getenv("ROBOFLOW_WORKSPACE") or "dioquino-jims-carl-k"
    if env_ids:
        out = []
        for mid in env_ids:
            slug, _, ver = mid.partition("/")
            out.append((slug, int(ver or "1"), default_ws))
        return out

    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    rows: list[tuple[str, int, str]] = []
    seen: set[str] = set()
    for group in ("expand8", "existing", "new"):
        for row in data.get(group) or []:
            mid = str(row.get("model_id") or "")
            if not mid:
                continue
            slug, _, ver = mid.partition("/")
            if slug in seen:
                continue
            seen.add(slug)
            ws = str(row.get("workspace") or default_ws)
            rows.append((slug, int(ver or "1"), ws))
    return rows


def download_all(api_key: str) -> None:
    from roboflow import Roboflow

    rf = Roboflow(api_key=api_key)
    DATASETS.mkdir(parents=True, exist_ok=True)
    cache: dict[str, object] = {}
    rows = catalog_download_rows()
    if not rows:
        raise SystemExit(
            "No datasets listed. Set ROBOFLOW_MODEL_IDS=project-slug/1 in detector/.env "
            "or add model_id entries to roboflow_datasets.json"
        )
    for slug, ver, preferred_ws in rows:
        dest = DATASETS / slug
        if (dest / "data.yaml").is_file():
            print(f"[skip] {slug} already downloaded")
            continue
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        workspaces = [preferred_ws] if preferred_ws else []
        for w in FALLBACK_WORKSPACES:
            if w not in workspaces:
                workspaces.append(w)
        ok = False
        for ws_name in workspaces:
            try:
                if ws_name not in cache:
                    cache[ws_name] = rf.workspace(ws_name)
                ws = cache[ws_name]
                print(f"[download] {ws_name}/{slug}/{ver} -> {dest}")
                ws.project(slug).version(ver).download("yolov8", location=str(dest))
                if (dest / "data.yaml").is_file():
                    ok = True
                    break
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] {ws_name}/{slug}/{ver}: {exc}")
        if not ok:
            print(f"[warn] could not download {slug}")


def train_primary() -> Path | None:
    preferred = (os.getenv("ROBOFLOW_PRIMARY") or "").strip()
    slug = preferred.partition("/")[0] if preferred else ""
    yaml_path = DATASETS / slug / "data.yaml" if slug else None
    if yaml_path is None or not yaml_path.is_file():
        found = sorted(DATASETS.glob("*/data.yaml"))
        yaml_path = found[0] if found else None
    if yaml_path is None or not yaml_path.is_file():
        print("[train] no data.yaml under detector/datasets")
        return None
    name = yaml_path.parent.name
    base = str(PRETRAINED) if PRETRAINED.is_file() else "yolov8n.pt"
    print(f"[train] {name} from {base} (CPU — leave this window open)")
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
    if not key:
        raise SystemExit("ROBOFLOW_API_KEY missing in detector/.env")
    download_all(key)
    print(
        "[hint] For accurate live detection with the 8 expand datasets, run:\n"
        "       python merge_train_expand8.py"
    )
    if os.getenv("ROBOFLOW_TRAIN", "").strip().lower() in {"1", "true", "yes"}:
        train_primary()
    else:
        print("[skip] single-dataset training disabled. export ROBOFLOW_TRAIN=1 to train one dataset.")


if __name__ == "__main__":
    main()
