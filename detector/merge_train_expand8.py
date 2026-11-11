"""
Merge Jimscarl (local / dioquino) + Harry (foreign / ejems) into one YOLO set
and train weights/trained/best.pt for accurate live detection.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

from dotenv import load_dotenv

# Avoid Windows cp1252 crashes on Roboflow progress arrows.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
CATALOG = ROOT / "roboflow_datasets.json"
DATASETS = ROOT / "datasets"
MERGED = DATASETS / "merged-expand8"
WEIGHTS_OUT = ROOT / "weights" / "trained" / "best.pt"
PRETRAINED = ROOT / "yolov8n.pt"
FALLBACK_WORKSPACES = ("dioquino-jims-carl-k", "ejems-workspace")
LOCAL_WORKSPACE = "dioquino-jims-carl-k"  # Jimscarl — local coastal labels
FOREIGN_WORKSPACE = "ejems-workspace"  # Harry — foreign / extra variety

# Canonical class order used by the merged model / UI.
UNIFIED = [
    "can",
    "cardboard",
    "face mask",
    "glass bottle",
    "paper bag",
    "paper cup",
    "paper drink carton",
    "plastic bag",
    "plastic bottle",
    "plastic cup",
    "plastic wrapper",
    "styrofoam",
    "plastic cellophane",
    "cigarette",
    "food waste",
    "garbage bag",
    "plastic straw",
    "plastic utensils",
    "metal",
    "organic waste",
    "paper",
    "plastic",
    "aluminium foil",
    "rope and string",
    "debris",
    "shoe",
    "toothbrush",
    "plastic container",
    "glass jar",
    "broken glass",
]

# Map noisy source labels → UNIFIED name (lowercase).
ALIASES: dict[str, str] = {
    "can": "can",
    "cans": "can",
    "food can": "can",
    "cardboard": "cardboard",
    "corrugated carton": "cardboard",
    "carton": "cardboard",
    "egg carton": "cardboard",
    "pizza box": "cardboard",
    "face mask": "face mask",
    "glass bottle": "glass bottle",
    "glass": "glass bottle",
    "glass jar": "glass jar",
    "glass cup": "plastic cup",
    "broken glass": "broken glass",
    "paper bag": "paper bag",
    "paper cup": "paper cup",
    "paper drink carton": "paper drink carton",
    "plastic bag": "plastic bag",
    "poly plastic bag": "plastic bag",
    "bag": "plastic bag",
    "polythene": "plastic bag",
    "garbage bag": "garbage bag",
    "trash bag": "garbage bag",
    "plastic bottle": "plastic bottle",
    "plastic bottle cap": "plastic bottle",
    "bottle": "plastic bottle",
    "bottle cap": "plastic bottle",
    "plastic cup": "plastic cup",
    "plastic cup cover": "plastic cup",
    "cup": "plastic cup",
    "styro cup": "styrofoam",
    "styrofoam cup": "styrofoam",
    "styro food container": "styrofoam",
    "plastic wrapper": "plastic wrapper",
    "wrapping paper": "plastic wrapper",
    "styrofoam": "styrofoam",
    "plastic cellophane": "plastic cellophane",
    "plastic film": "plastic cellophane",
    "aluminium foil": "aluminium foil",
    "aluminium wrap": "aluminium foil",
    "aluminum foil": "aluminium foil",
    "cigarette": "cigarette",
    "food waste": "food waste",
    "plastic straw": "plastic straw",
    "paper straw": "plastic straw",
    "straw": "plastic straw",
    "plastic utensils": "plastic utensils",
    "plastic gloves": "plastic utensils",
    "plastic glooves": "plastic utensils",
    "plastic spoon": "plastic utensils",
    "spoon": "plastic utensils",
    "metal": "metal",
    "scrap metal": "metal",
    "metal bottle cap": "metal",
    "organic waste": "organic waste",
    "paper": "paper",
    "normal paper": "paper",
    "magazine paper": "paper",
    "paper tissue": "paper",
    "tissues": "paper",
    "news paper": "paper",
    "newspaper": "paper",
    "plastic": "plastic",
    "plastic container": "plastic container",
    "plastic egg tray": "plastic container",
    "food container": "plastic container",
    "packet": "plastic wrapper",
    "rope and string": "rope and string",
    "rope and strings": "rope and string",
    "rope": "rope and string",
    "debris": "debris",
    "litter": "debris",
    "fishing item": "debris",
    "net": "debris",
    "toy": "debris",
    "rubber": "debris",
    "shoe": "shoe",
    "shoes": "shoe",
    "slipper": "shoe",
    "slippers": "shoe",
    "toothbrush": "toothbrush",
    "styro foam": "styrofoam",
    "object": "",
    "others": "",
    "other": "",
    "sunglass": "",
}


def _norm(name: str) -> str:
    return " ".join(str(name).replace("_", " ").replace("-", " ").split()).lower()


def canonicalize(raw: str) -> str | None:
    key = _norm(raw)
    if not key or key in {"object", "others", "other"} or re.fullmatch(r"\d+", key):
        return None
    if key in ALIASES:
        mapped = ALIASES[key]
        return mapped or None
    if key in UNIFIED:
        return key
    # Longest phrase first so "plastic bottle" wins over "plastic" / "bottle".
    hits = [u for u in UNIFIED if u in key or key in u]
    if not hits:
        return None
    hits.sort(key=len, reverse=True)
    return hits[0]


def is_local_row(row: dict) -> bool:
    ws = str(row.get("workspace") or "").strip().lower()
    mid = str(row.get("model_id") or "").lower()
    return ws == LOCAL_WORKSPACE or mid.startswith("yolo-v7-trash") or mid.startswith("yolov7-trash")


def load_expand8_rows() -> list[dict]:
    """Jimscarl local first, then Harry foreign — one combined train."""
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    rows: list[dict] = []
    seen: set[str] = set()
    # Local (Jimscarl / new) before foreign (Harry / expand8).
    for group in ("new", "expand8"):
        for row in data.get(group) or []:
            if not isinstance(row, dict):
                continue
            mid = str(row.get("model_id") or "")
            if not mid or mid in seen:
                continue
            seen.add(mid)
            rows.append(row)
    rows.sort(key=lambda r: (0 if is_local_row(r) else 1))
    return rows


def parse_names(yaml_path: Path) -> list[str]:
    text = yaml_path.read_text(encoding="utf-8", errors="ignore")
    names: list[str] = []
    in_names = False
    for line in text.splitlines():
        if line.strip().startswith("names:"):
            rest = line.split(":", 1)[1].strip()
            if rest.startswith("["):
                inner = rest.strip("[]")
                return [x.strip().strip("'\"") for x in inner.split(",") if x.strip()]
            in_names = True
            continue
        if in_names:
            if re.match(r"^[a-zA-Z]", line) and not line.strip().startswith("-"):
                break
            m = re.match(r"^\s*-\s*['\"]?(.*?)['\"]?\s*$", line)
            if m:
                names.append(m.group(1))
            elif line.strip() and not line.strip().startswith("#"):
                # numbered dict style "0: Can"
                m2 = re.match(r"^\s*\d+\s*:\s*['\"]?(.*?)['\"]?\s*$", line)
                if m2:
                    names.append(m2.group(1))
                elif ":" in line and not line.strip().startswith("-"):
                    break
    return names


def download_expand8(api_key: str) -> None:
    DATASETS.mkdir(parents=True, exist_ok=True)
    missing: list[tuple[dict, str, int]] = []
    for row in load_expand8_rows():
        mid = str(row.get("model_id") or "")
        slug, _, ver_s = mid.partition("/")
        if not slug:
            continue
        dest = DATASETS / slug
        if (dest / "data.yaml").is_file():
            print(f"[skip] {slug} already downloaded", flush=True)
            continue
        missing.append((row, slug, int(ver_s or "1")))
    if not missing:
        print("[download] all catalog datasets already on disk", flush=True)
        return

    from roboflow import Roboflow

    rf = Roboflow(api_key=api_key)
    cache: dict[str, object] = {}

    for row, slug, ver in missing:
        mid = str(row.get("model_id") or "")
        slug, _, ver_s = mid.partition("/")
        ver = int(ver_s or "1")
        if not slug:
            continue
        dest = DATASETS / slug
        if (dest / "data.yaml").is_file():
            print(f"[skip] {slug} already downloaded")
            continue
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)

        workspaces = []
        ws0 = str(row.get("workspace") or "").strip()
        if ws0:
            workspaces.append(ws0)
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


def _link_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        return
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def merge_expand8() -> Path | None:
    """Build datasets/merged-expand8 with remapped labels."""
    if MERGED.exists():
        shutil.rmtree(MERGED)
    for split in ("train", "valid"):
        (MERGED / split / "images").mkdir(parents=True, exist_ok=True)
        (MERGED / split / "labels").mkdir(parents=True, exist_ok=True)

    unified_index = {name: i for i, name in enumerate(UNIFIED)}
    used = 0
    skipped = 0

    for row in load_expand8_rows():
        mid = str(row.get("model_id") or "")
        slug = mid.partition("/")[0]
        root = DATASETS / slug
        yaml_path = root / "data.yaml"
        if not yaml_path.is_file():
            print(f"[merge] skip missing {slug}")
            continue
        names = parse_names(yaml_path)
        if not names:
            print(f"[merge] no names in {slug}")
            continue
        copies = 2 if is_local_row(row) else 1
        origin = "local Jimscarl" if copies > 1 else "foreign Harry"
        print(f"[merge] {slug} · {len(names)} source classes · {origin} x{copies}")

        for split_src, split_dst in (("train", "train"), ("valid", "valid"), ("val", "valid"), ("test", "valid")):
            img_dir = root / split_src / "images"
            lbl_dir = root / split_src / "labels"
            if not img_dir.is_dir():
                # Roboflow sometimes nests differently
                alt = root / split_src
                if (alt / "images").is_dir():
                    img_dir = alt / "images"
                    lbl_dir = alt / "labels"
                else:
                    continue
            for img in img_dir.iterdir():
                if img.suffix.lower() not in {".jpg", ".jpeg", ".png", ".bmp", ".webp"}:
                    continue
                label = lbl_dir / f"{img.stem}.txt"
                out_lines: list[str] = []
                if label.is_file():
                    for line in label.read_text(encoding="utf-8", errors="ignore").splitlines():
                        parts = line.strip().split()
                        if len(parts) < 5:
                            continue
                        try:
                            src_id = int(float(parts[0]))
                        except ValueError:
                            continue
                        if src_id < 0 or src_id >= len(names):
                            skipped += 1
                            continue
                        canon = canonicalize(names[src_id])
                        if not canon or canon not in unified_index:
                            skipped += 1
                            continue
                        new_id = unified_index[canon]
                        out_lines.append(" ".join([str(new_id), *parts[1:]]))
                # Keep images even if empty labels (background) — skip empty to save size
                if not out_lines:
                    continue
                label_text = "\n".join(out_lines) + "\n"
                for copy_i in range(copies):
                    suffix = "" if copy_i == 0 else f"_r{copy_i}"
                    prefix = f"{slug}_{img.stem}{suffix}"
                    _link_or_copy(img, MERGED / split_dst / "images" / f"{prefix}{img.suffix.lower()}")
                    (MERGED / split_dst / "labels" / f"{prefix}.txt").write_text(
                        label_text, encoding="utf-8"
                    )
                    used += 1

    if used == 0:
        print("[merge] no labeled images produced")
        return None

    names_block = "\n".join(f"  - {n}" for n in UNIFIED)
    data_yaml = (
        f"path: {MERGED.as_posix()}\n"
        f"train: train/images\n"
        f"val: valid/images\n"
        f"nc: {len(UNIFIED)}\n"
        f"names:\n{names_block}\n"
    )
    out_yaml = MERGED / "data.yaml"
    out_yaml.write_text(data_yaml, encoding="utf-8")
    print(f"[merge] wrote {out_yaml} · {used} images · skipped labels {skipped}")
    return out_yaml


def should_train() -> bool:
    flag = os.getenv("ROBOFLOW_TRAIN", "").strip().lower()
    if flag in {"0", "false", "no"}:
        return False
    if flag in {"1", "true", "yes"}:
        return True
    merged_yaml = MERGED / "data.yaml"
    if not WEIGHTS_OUT.is_file():
        return True
    if merged_yaml.is_file() and WEIGHTS_OUT.stat().st_mtime < merged_yaml.stat().st_mtime:
        return True
    return False


def train_merged(yaml_path: Path) -> Path | None:
    from ultralytics import YOLO

    last = ROOT / "runs" / "expand8" / "weights" / "last.pt"
    base = (
        str(last)
        if last.is_file()
        else (str(PRETRAINED) if PRETRAINED.is_file() else "yolov8n.pt")
    )
    # More of the combined set than the 8×0.4 speed run; resume from last.pt
    # so epoch-1 weights are not thrown away.
    epochs = int(os.getenv("EXPAND8_EPOCHS", "12") or "12")
    fraction = float(os.getenv("EXPAND8_FRACTION", "0.6") or "0.6")
    print(
        f"[train] local Jimscarl + foreign Harry from {base} "
        f"(CPU epochs={epochs} fraction={fraction} — leave this window open)"
    )
    model = YOLO(base)
    model.train(
        data=str(yaml_path),
        epochs=epochs,
        imgsz=640,
        batch=4,
        device="cpu",
        workers=0,
        patience=max(4, epochs // 2),
        fraction=fraction,
        project=str(ROOT / "runs"),
        name="expand8",
        exist_ok=True,
        pretrained=True,
        verbose=True,
    )
    best = ROOT / "runs" / "expand8" / "weights" / "best.pt"
    if not best.is_file():
        print("[train] best.pt not found")
        return None
    WEIGHTS_OUT.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best, WEIGHTS_OUT)
    print(f"[train] copied {WEIGHTS_OUT}")
    # Mark expand8 rows trained in catalog
    try:
        data = json.loads(CATALOG.read_text(encoding="utf-8"))
        for group in ("expand8", "new"):
            for row in data.get(group) or []:
                if isinstance(row, dict):
                    row["trained"] = True
        CATALOG.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    except (OSError, json.JSONDecodeError, TypeError):
        pass
    return WEIGHTS_OUT


def main() -> None:
    load_dotenv(ROOT / ".env")
    key = os.getenv("ROBOFLOW_API_KEY") or ""
    if not key:
        raise SystemExit("ROBOFLOW_API_KEY missing in detector/.env")
    download_expand8(key)
    yaml_path = merge_expand8()
    if yaml_path is None:
        raise SystemExit("merge failed — no datasets available")
    if should_train():
        train_merged(yaml_path)
    else:
        print(
            "[skip] training disabled — best.pt up to date or ROBOFLOW_TRAIN=0. "
            "Use export ROBOFLOW_TRAIN=1 to force retrain."
        )


if __name__ == "__main__":
    main()
