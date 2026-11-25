"""Turn a trained .pt into the fixed 640 ONNX file the cameras load.

The detector labels boxes with the model's own class names, in the model's own
order, so a newly trained model may add classes (or order them differently).
The class names are printed as  CLASSES_JSON=[...]  so the API can save them.
"""

from __future__ import annotations

import shutil
import sys
import json
from pathlib import Path

from ultralytics import YOLO

EXPECTED = [
    "Can",
    "Cardboard",
    "Ecobag",
    "Face Mask",
    "Glass Bottle",
    "Paper Bag",
    "Paper Drink Carton",
    "Plastic Bottle",
    "Plastic Cellophane",
    "Plastic Cup",
    "Plastic Spoon",
    "Plastic Wrapper",
    "Styro Cup",
    "Styrofoam",
]


def class_names(model) -> list[str]:
    names = model.names
    if isinstance(names, dict):
        return [str(names[i]) for i in range(len(names))]
    return [str(name) for name in list(names)]


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: install_trained_onnx.py SOURCE.pt DEST.onnx")
    src = Path(sys.argv[1])
    dest = Path(sys.argv[2])
    if not src.is_file():
        raise SystemExit(f"missing weights: {src}")
    model = YOLO(str(src))
    ordered = class_names(model)
    if not ordered or any(not name.strip() for name in ordered):
        raise SystemExit("the trained model has no class names")
    added = [name for name in ordered if name not in EXPECTED]
    if added:
        print("new classes in this model: " + ", ".join(added))
    exported = Path(
        model.export(
            format="onnx",
            imgsz=640,
            opset=12,
            dynamic=False,
            simplify=False,
        )
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    if exported.resolve() != dest.resolve():
        shutil.copy2(exported, dest)
    print(f"exported {dest}")
    print("CLASSES_JSON=" + json.dumps(ordered))


if __name__ == "__main__":
    main()
