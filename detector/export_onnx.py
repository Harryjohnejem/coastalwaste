"""Export the CCTV YOLOv11n weights to a fixed 640x640 ONNX file.

Source: Downloads/weights (4).pt (13 classes, no Plastic Bag).
Destination: detector/weights/trained/best.onnx — the path app.py loads.

weights (6) stays in best-weights6.onnx and weights-6.onnx.
best.onnx.backup-before-weights6 is left untouched.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent
SRC = Path(r"C:\Users\Admin\Downloads\weights (4).pt")
LOCAL_COPY = ROOT / "weights" / "trained" / "weights-4.pt"
DEST = ROOT / "weights" / "trained" / "best.onnx"
DEST_NAMED = ROOT / "weights" / "trained" / "best-weights4.onnx"


def main() -> None:
    if not SRC.is_file() and not LOCAL_COPY.is_file():
        raise SystemExit(f"missing weights: {SRC} (or {LOCAL_COPY})")
    src = SRC if SRC.is_file() else LOCAL_COPY
    DEST.parent.mkdir(parents=True, exist_ok=True)
    if src.resolve() != LOCAL_COPY.resolve():
        shutil.copy2(src, LOCAL_COPY)

    model = YOLO(str(LOCAL_COPY))
    names = model.names
    ordered = [names[i] for i in range(len(names))] if isinstance(names, dict) else list(names)
    print(f"[export] classes ({len(ordered)}): {ordered}")
    exported = Path(
        model.export(
            format="onnx",
            imgsz=640,
            opset=12,
            dynamic=False,
            simplify=False,
        )
    )
    shutil.copy2(exported, DEST_NAMED)
    shutil.copy2(exported, DEST)
    shutil.copy2(LOCAL_COPY, ROOT / "weights" / "trained" / "best.pt")
    print(f"[export] wrote {DEST_NAMED}")
    print(f"[export] wrote {DEST}")


if __name__ == "__main__":
    main()
