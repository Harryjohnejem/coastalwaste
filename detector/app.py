"""
Coastal waste detector — YOLOv8-World (open-vocab / text embeddings).

Pulls frames from go2rtc, runs YOLO-World with waste class prompts,
posts live boxes + log hits to the Laravel API.
"""

from __future__ import annotations

import base64
import os
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Any

# Set before OpenCV loads FFmpeg. TCP avoids dropped UDP packets that show up
# as H.264 "bytestream" decode errors. Quiet level hides those decoder lines.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
os.environ.setdefault("OPENCV_FFMPEG_LOGLEVEL", "-8")

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic_settings import BaseSettings, SettingsConfigDict
from ultralytics import YOLO

from presence import PresenceBook, SceneMotion, hue_histogram
from streams import (
    LatestFrameReader,
    StreamConfig,
    StreamPublishState,
    annotate_detection_stages,
    draw_detection_boxes,
    encode_jpeg,
    new_byte_tracker,
    parse_detector_streams,
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).with_name(".env")),
        extra="ignore",
    )

    go2rtc_frame_url: str = "http://127.0.0.1:1990/api/frame.jpeg?src=cam01"
    go2rtc_base: str = "http://127.0.0.1:1990"
    rtsp_url: str = ""
    camera_id: str = "CAM-01"
    sector: str = "Sector B"
    api_base: str = "http://127.0.0.1:8000/api"
    detector_key: str = "tidalwatch-detector-local"
    interval_s: float = 0.5
    # How often each camera looks for objects outside the 13 CCTV classes.
    unfamiliar_interval_s: float = 20.0
    # full_plus_tiles (alias: two_strip) = full frame + 2x2. tiles_2x2 / full_frame are faster.
    detection_mode: str = "two_strip"
    # HUD floor for solid labels. Scores outside 80–98% are not shown or saved.
    conf: float = 0.80
    # YOLO recall threshold. Must be below HUD so dataset objects can be found first.
    proposal_conf: float = 0.25
    record_conf: float = 0.80
    iou: float = 0.50
    # Live boxes require 80–98%. Scores outside that band are not drawn.
    # Geometry identity remaps (bottle→carton, etc.). Off by default — do not invent labels.
    class_identity_remap: bool = False
    min_confirmation_frames: int = 3
    detection_cooldown_seconds: float = 10.0
    # Keep a recorded track briefly after it drops out, so a new ID is not saved again.
    track_lost_timeout_seconds: float = 3.0
    log_cooldown_s: float = 10.0
    # Processed frames a saved object must stay missing before an inferred removal.
    absence_frames: int = 8
    # OpenCV MOG2 motion detection (complements YOLO; never gates inference).
    motion_min_area: int = 800
    motion_history: int = 120
    motion_var_threshold: float = 40.0
    motion_detect_shadows: bool = True
    motion_morph_kernel: int = 5
    motion_learning_rate: float = -1.0
    motion_box_fraction: float = 0.08
    motion_debug: bool = False
    # Rebuild background model after this many consecutive missing frames.
    motion_reset_after_misses: int = 5
    # Multi-stream: JSON array. Empty = legacy single CAMERA_ID / RTSP_URL.
    detector_streams: str = ""
    tapo_rtsp_user: str = ""
    tapo_rtsp_pass: str = ""
    tapo_host: str = ""
    # Second physical camera. Empty unless this process must open its RTSP itself.
    tapo2_rtsp_user: str = ""
    tapo2_rtsp_pass: str = ""
    tapo2_host: str = ""
    # Serialize ONNX predict across streams (1 = safest on CPU).
    max_concurrent_inference: int = 1
    stream_reconnect_s: float = 0.5
    # Pause after a successful JPEG grab. Failures still use stream_reconnect_s.
    stream_capture_interval_s: float = 0.1
    # Burn boxes into JPEG for /annotated.* (expensive). Live UI uses go2rtc + overlay.
    annotate_frames: bool = False
    # YOLO input size — must match ONNX export (best.onnx is fixed at 640).
    imgsz: int = 640
    go2rtc_rtsp_base: str = "rtsp://127.0.0.1:8561"
    model_name: str = "yolov8s-worldv2.pt"
    host: str = "127.0.0.1"
    port: int = 8092
    roboflow_api_key: str = ""
    roboflow_workspace: str = "dioquino-jims-carl-k"
    roboflow_model_ids: str = ""
    roboflow_primary: str = "yolov7-trash-05-04-2023-by3ff/1"
    roboflow_workflow_id: str = "local-datasets-vlocal-datasets-fgmmm-2-yolo11n-t1-logic"


# YOLOv11n best.onnx class order from weights (4).pt (CCTV dataset).
ONNX_CLASSES = [
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
    "Plastic Wrapper",
    "Styro Cup",
    "Styrofoam",
]
WASTE_CLASSES = ONNX_CLASSES
# Hard floor: never draw or record below 70% confidence.
MIN_DETECT_CONF = 0.80
MAX_DETECT_CONF = 0.98
MIN_PROPOSAL_CONF = 0.25
# Filled from the loaded ONNX model.names (canonical dataset labels).
_model_classes: list[str] = list(ONNX_CLASSES)

SEVERITY = {
    "plastic bottle": "alert",
    "plastic bag": "alert",
    "plastic cup": "alert",
    "plastic wrapper": "alert",
    "plastic cellophane": "alert",
    "plastic straw": "alert",
    "plastic utensils": "alert",
    "plastic container": "alert",
    "plastic": "alert",
    "fishing net": "warn",
    "styrofoam": "alert",
    "trash bag": "alert",
    "garbage bag": "alert",
    "can": "alert",
    "cans": "alert",
    "cup": "alert",
    "paper cup": "warn",
    "paper bag": "warn",
    "paper drink carton": "warn",
    "paper": "warn",
    "cardboard": "warn",
    "glass bottle": "alert",
    "glass jar": "alert",
    "broken glass": "alert",
    "face mask": "warn",
    "cigarette": "warn",
    "food waste": "info",
    "organic waste": "info",
    "metal": "warn",
    "aluminium foil": "warn",
    "rope and string": "warn",
    "debris": "warn",
    "litter": "warn",
    "shoe": "info",
    "toothbrush": "warn",
    "person": "info",
    "boat": "info",
}

LABEL = {
    "plastic bottle": "Plastic Bottle",
    "plastic bag": "Plastic Bag",
    "plastic cup": "Plastic Cup",
    "plastic wrapper": "Plastic Wrapper",
    "plastic cellophane": "Plastic Cellophane",
    "plastic straw": "Plastic Straw",
    "plastic utensils": "Plastic Utensils",
    "plastic container": "Plastic Container",
    "plastic": "Plastic",
    "fishing net": "Abandoned fishing net",
    "styrofoam": "Styrofoam",
    "trash bag": "Trash bag",
    "garbage bag": "Garbage Bag",
    "can": "Can",
    "cans": "Cans",
    "cup": "Disposable cup",
    "paper cup": "Paper Cup",
    "paper bag": "Paper Bag",
    "paper drink carton": "Paper Drink Carton",
    "paper": "Paper",
    "cardboard": "Cardboard",
    "glass bottle": "Glass Bottle",
    "glass jar": "Glass Jar",
    "broken glass": "Broken Glass",
    "face mask": "Face Mask",
    "cigarette": "Cigarette",
    "food waste": "Food Waste",
    "organic waste": "Organic Waste",
    "metal": "Metal",
    "aluminium foil": "Aluminium Foil",
    "rope and string": "Rope and String",
    "debris": "Coastal debris",
    "litter": "Litter",
    "shoe": "Shoe",
    "toothbrush": "Toothbrush",
    "person": "Person",
    "boat": "Vessel",
}


def _norm_class(name: str) -> str:
    return " ".join(str(name or "").lower().replace("_", " ").replace("-", " ").split())


_CLASS_BY_NORM = {_norm_class(name): name for name in ONNX_CLASSES}
_reject_logged_at: dict[tuple, float] = {}


def log_rejected(camera_id: str, label: str, confidence: float, reason: str, infer_ms: int | None = None) -> None:
    """Throttled diagnostic for predictions that are not drawn or saved."""
    key = (str(camera_id), str(reason), str(label))
    now = time.time()
    if now - _reject_logged_at.get(key, 0.0) < 5.0:
        return
    _reject_logged_at[key] = now
    timing = f" infer_ms={infer_ms}" if infer_ms is not None else ""
    print(
        f"[detector] reject {camera_id} {label} "
        f"conf={float(confidence):.2f} reason={reason}{timing}"
    )
_CLASS_ALIASES = {
    "styro cup": "Styro Cup",
    "styrofoam cup": "Styro Cup",
    "styrofoam-cup": "Styro Cup",
    "eco bag": "Ecobag",
    "eco bagg": "Ecobag",
    "facemask": "Face Mask",
    "face-mask": "Face Mask",
    "paper carton": "Paper Drink Carton",
    "drink carton": "Paper Drink Carton",
    "juice carton": "Paper Drink Carton",
    "cellophane": "Plastic Cellophane",
}


def canonical_waste_class(raw: str) -> str | None:
    """Map a model/raw label onto the 13 CCTV class names."""
    key = _norm_class(raw)
    if not key:
        return None
    if key in _CLASS_BY_NORM:
        return _CLASS_BY_NORM[key]
    alias = _CLASS_ALIASES.get(key)
    if alias:
        return alias
    mapped = LABEL.get(key)
    if mapped:
        official = _CLASS_BY_NORM.get(_norm_class(mapped))
        if official:
            return official
    return None


def resolve_model_classes(model) -> list[str]:
    """Prefer ONNX model.names, rewritten to official dataset labels."""
    names = getattr(model, "names", None) or {}
    if isinstance(names, dict):
        ordered = [str(names[i]) for i in range(len(names))]
    else:
        ordered = [str(item) for item in list(names)]
    if len(ordered) != len(ONNX_CLASSES):
        print(
            f"[detector] WARNING: ONNX class count {len(ordered)} != "
            f"{len(ONNX_CLASSES)} official names. Falling back to ONNX_CLASSES. "
            f"raw={ordered}"
        )
        return list(ONNX_CLASSES)
    mapped = [canonical_waste_class(item) or item for item in ordered]
    mismatched = [
        (index, raw, official)
        for index, (raw, official) in enumerate(zip(mapped, ONNX_CLASSES))
        if raw != official
    ]
    if mismatched:
        print(f"[detector] WARNING: ONNX class names differ from ONNX_CLASSES: {mismatched}")
    return mapped


def onnx_runtime_providers() -> list[str]:
    """Providers actually installed. CUDA is used only if this list includes it."""
    try:
        import onnxruntime as ort

        return list(ort.get_available_providers())
    except Exception:  # noqa: BLE001
        return []


def dataset_class_set() -> set[str]:
    return set(_model_classes) | set(ONNX_CLASSES)


settings = Settings()
_stop = Event()
_lock = Lock()
_inference_lock = Lock()
_state: dict[str, Any] = {
    "ready": False,
    "last_ms": None,
    "last_boxes": [],
    "last_error": None,
    "frames": 0,
    "catalog": [],
    "last_jpeg": None,
    "model_label": "YOLO-World",
    "frame_id": None,
    "frame_captured_at": None,
}
# camera_id → StreamPublishState (filled by per-stream workers)
_stream_states: dict[str, StreamPublishState] = {}
_stream_configs: list[StreamConfig] = []
_rtsp_cap: cv2.VideoCapture | None = None
TRAINED_WEIGHTS = Path(__file__).with_name("weights") / "trained" / "best.pt"
ONNX_WEIGHTS = Path(__file__).with_name("weights") / "trained" / "best.onnx"
LOCAL_YAML = Path(__file__).with_name("datasets") / "local-merged" / "data.yaml"


# Max box size as a percent of the wide live frame. A person or wall mistaken
# for a bottle is far larger than a real item from this 14-class model.
_MAX_BOX_PCT = {
    "plastic bag": (50.0, 55.0),
    "ecobag": (50.0, 55.0),
    "cardboard": (50.0, 55.0),
    "styrofoam": (45.0, 50.0),
    "plastic bottle": (40.0, 50.0),
    "paper bag": (45.0, 50.0),
}
_DEFAULT_MAX_BOX_PCT = (40.0, 45.0)


def filter_overlay_boxes(boxes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep object-sized boxes and drop person-sized false positives."""
    kept: list[dict[str, Any]] = []
    for b in boxes:
        w = float(b.get("width") or 0)
        h = float(b.get("height") or 0)
        raw = str(b.get("raw_class") or b.get("class") or "").lower()
        max_w, max_h = _MAX_BOX_PCT.get(raw, _DEFAULT_MAX_BOX_PCT)
        if w < 0.3 or h < 0.3:
            continue
        if is_person_sized(b):
            continue
        if w > max_w or h > max_h:
            continue
        if (w / 100.0) * (h / 100.0) > 0.18 and raw not in _MAX_BOX_PCT:
            continue
        kept.append(b)
    return kept


def load_dataset_catalog() -> tuple[list[dict[str, Any]], list[str]]:
    """Only the 14-class local-merged dataset."""
    row = {
        "name": "local-merged",
        "model_id": "local-datasets/1",
        "workspace": "dioquino-jims-carl-k",
        "group": "local-merged",
        "trained": True,
        "map": "",
        "yaml": str(LOCAL_YAML),
        "classes": list(ONNX_CLASSES),
    }
    return [row], list(ONNX_CLASSES)


def grab_frame_rtsp(url: str) -> np.ndarray | None:
    global _rtsp_cap
    try:
        if _rtsp_cap is None or not _rtsp_cap.isOpened():
            _rtsp_cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
            _rtsp_cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        # Drop frames queued in the RTSP buffer, then decode the newest one.
        grabbed = False
        for _ in range(3):
            if not _rtsp_cap.grab():
                break
            grabbed = True
        if grabbed:
            ok, frame = _rtsp_cap.retrieve()
            if ok and frame is not None:
                return frame
        if _rtsp_cap is not None:
            _rtsp_cap.release()
        _rtsp_cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        ok, frame = _rtsp_cap.read()
        return frame if ok else None
    except Exception as exc:  # noqa: BLE001
        _state["last_error"] = f"rtsp: {exc}"
        return None


_MODE_ALIASES = {
    "two_strip": "full_plus_tiles",
    "full": "full_frame",
    "fullframe": "full_frame",
    "tiles": "tiles_2x2",
    "2x2": "tiles_2x2",
    "full_plus_2x2": "full_plus_tiles",
    "full+tiles": "full_plus_tiles",
}


def detection_mode(raw: str | None = None) -> str:
    """Canonical inference mode: full_frame | tiles_2x2 | full_plus_tiles."""
    mode = str(raw if raw is not None else settings.detection_mode or "two_strip")
    mode = mode.strip().lower().replace("-", "_").replace(" ", "_")
    mode = _MODE_ALIASES.get(mode, mode)
    if mode in {"full_frame", "tiles_2x2", "full_plus_tiles"}:
        return mode
    return "full_plus_tiles"


def inference_regions(
    width: int,
    height: int,
    mode: str | None = None,
) -> list[tuple[int, int, int, int]]:
    """Crops for one frame. Narrow frames stay a single shot in every mode."""
    resolved = detection_mode(mode)
    if resolved == "full_frame" or width < 960:
        return [(0, 0, width, height)]
    tiles = _frame_tiles(width, height)
    if resolved == "tiles_2x2":
        return tiles
    if len(tiles) > 1:
        return [(0, 0, width, height), *tiles]
    return tiles


class _LatestRtsp:
    """Keep only the newest decoded RTSP frame.

    The reader thread is the only place that waits for a camera packet.
    latest() returns immediately with the frame already in hand, or nothing.
    It does not grab extra times in the hope that a future frame will arrive.
    """

    def __init__(self) -> None:
        self._lock = Lock()
        self._frame: np.ndarray | None = None
        self._frame_id = 0
        self._captured_at: float | None = None
        self._thread: Thread | None = None

    def start(self, url: str) -> None:
        if self._thread is not None:
            return
        self._thread = Thread(
            target=self._read_loop,
            args=(url,),
            name="rtsp-latest",
            daemon=True,
        )
        self._thread.start()

    def _read_loop(self, url: str) -> None:
        cap: cv2.VideoCapture | None = None
        while not _stop.is_set():
            if cap is None or not cap.isOpened():
                cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            ok, frame = cap.read()
            if not ok or frame is None:
                cap.release()
                cap = None
                _stop.wait(0.2)
                continue
            with self._lock:
                self._frame_id += 1
                self._frame = frame
                self._captured_at = time.time()
        if cap is not None:
            cap.release()

    def latest(self) -> tuple[np.ndarray | None, int | None, float | None]:
        with self._lock:
            if self._frame is None or self._captured_at is None:
                return None, None, None
            return self._frame.copy(), self._frame_id, self._captured_at

    def next_id(self, captured_at: float) -> tuple[int, float]:
        """Id for a non-RTSP frame. Does not replace the RTSP slot."""
        with self._lock:
            self._frame_id += 1
            return self._frame_id, captured_at


_latest_rtsp = _LatestRtsp()


def grab_frame(url: str) -> np.ndarray | None:
    try:
        with httpx.Client(timeout=5.0) as client:
            r = client.get(url)
            r.raise_for_status()
            arr = np.frombuffer(r.content, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is not None:
                _state["frame_source"] = "jpeg"
                return img
    except Exception:  # noqa: BLE001
        pass
    _state["last_error"] = "no camera frame — start go2rtc (port 1990) or check RTSP"
    return None


def acquire_frame() -> tuple[np.ndarray | None, int | None, float | None]:
    """Prefer the newest RTSP frame already decoded; fall back to the go2rtc JPEG."""
    if settings.rtsp_url.strip():
        frame, frame_id, captured_at = _latest_rtsp.latest()
        if frame is not None:
            _state["frame_source"] = "rtsp"
            _state["last_error"] = None
            return frame, frame_id, captured_at
    frame = grab_frame(settings.go2rtc_frame_url)
    if frame is None:
        return None, None, None
    frame_id, captured_at = _latest_rtsp.next_id(time.time())
    return frame, frame_id, captured_at


def parse_model_ids(raw: str) -> list[str]:
    return [x.strip() for x in (raw or "").split(",") if x.strip()]


def primary_roboflow_id() -> str:
    ids = parse_model_ids(settings.roboflow_model_ids)
    chosen = (settings.roboflow_primary or "").strip()
    if chosen:
        return chosen if "/" in chosen else f"{chosen}/1"
    return ids[0] if ids else ""


def boxes_from_roboflow(
    payload: dict[str, Any],
    conf_min: float,
    frame_w: float = 0,
    frame_h: float = 0,
) -> list[dict[str, Any]]:
    image = payload.get("image") or {}
    w = float(image.get("width") or 0) or float(frame_w or 0) or 1.0
    h = float(image.get("height") or 0) or float(frame_h or 0) or 1.0
    out: list[dict[str, Any]] = []
    for pred in payload.get("predictions") or []:
        if not isinstance(pred, dict):
            continue
        score = float(pred.get("confidence") or 0)
        if score < conf_min:
            continue
        raw = str(pred.get("class") or "").strip().lower()
        if not raw:
            continue
        bw = float(pred.get("width") or 0)
        bh = float(pred.get("height") or 0)
        cx = float(pred.get("x") or 0)
        cy = float(pred.get("y") or 0)
        x1 = cx - bw / 2
        y1 = cy - bh / 2
        cls_id = pred.get("class_id", raw)
        label = LABEL.get(raw, str(pred.get("class") or raw.title()))
        out.append(
            {
                "id": f"rf-{cls_id}-{int(x1)}-{int(y1)}",
                "class": label,
                "raw_class": raw,
                "confidence": round(score, 4),
                "severity": SEVERITY.get(raw, "alert"),
                "variant": "sand" if "net" in raw or "fishing" in raw else None,
                "left": round(x1 / w * 100, 2),
                "top": round(y1 / h * 100, 2),
                "width": round(bw / w * 100, 2),
                "height": round(bh / h * 100, 2),
            }
        )
    return out


def infer_roboflow(client: httpx.Client, model_id: str, jpeg: bytes) -> dict[str, Any]:
    conf_pct = int(settings.conf * 100) if settings.conf <= 1 else int(settings.conf)
    response = client.post(
        f"https://serverless.roboflow.com/{model_id}",
        params={
            "api_key": settings.roboflow_api_key,
            "confidence": max(1, min(conf_pct, 99)),
            "overlap": 50,
        },
        files={"file": ("frame.jpg", jpeg, "image/jpeg")},
        timeout=20.0,
    )
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict):
        raise RuntimeError("Roboflow returned a non-object payload")
    return data


def _frame_tiles(width: int, height: int) -> list[tuple[int, int, int, int]]:
    """Overlapping tiles so a wide 2304px Tapo frame is not crushed into one 640 input.

    Horizontal-only strips still resize the full width to 640 and erase small waste.
    For wide frames use a 2x2 grid (with overlap). Narrow frames stay single-shot.
    """
    if width < 960:
        return [(0, 0, width, height)]
    # 2x2 with 25% overlap — weights (6) fired on quadrant crops, not full-frame letterbox.
    overlap = 0.25
    nx, ny = 2, 2
    tw = int(width / nx * (1.0 + overlap))
    th = int(height / ny * (1.0 + overlap))
    tw = min(width, max(tw, width // nx))
    th = min(height, max(th, height // ny))
    tiles: list[tuple[int, int, int, int]] = []
    for iy in range(ny):
        for ix in range(nx):
            x0 = int(ix * (width - tw) / (nx - 1)) if nx > 1 else 0
            y0 = int(iy * (height - th) / (ny - 1)) if ny > 1 else 0
            x1 = min(width, x0 + tw)
            y1 = min(height, y0 + th)
            tiles.append((x0, y0, x1, y1))
    return tiles


def _dedupe_boxes(boxes: list[dict[str, Any]], iou_min: float = 0.25) -> list[dict[str, Any]]:
    """Keep one box per object. A weaker box inside a stronger one is dropped."""
    ranked = sorted(boxes, key=lambda b: b["confidence"], reverse=True)
    kept: list[dict[str, Any]] = []
    for box in ranked:
        if any(_same_object(box, prev, iou_min) for prev in kept):
            continue
        kept.append(box)
    return kept


def _same_object(a: dict[str, Any], b: dict[str, Any], iou_min: float) -> bool:
    """True only when two boxes overlap. Nearby items in a pile stay separate."""
    if _iou(a, b) >= iou_min:
        return True
    smaller = min(_box_area(a), _box_area(b))
    return smaller > 0 and _intersection(a, b) / smaller >= 0.35


def _box_area(box: dict[str, Any]) -> float:
    return max(0.0, float(box.get("width") or 0)) * max(0.0, float(box.get("height") or 0))


def _intersection(a: dict[str, Any], b: dict[str, Any]) -> float:
    ax1, ay1 = float(a["left"]), float(a["top"])
    ax2, ay2 = ax1 + float(a["width"]), ay1 + float(a["height"])
    bx1, by1 = float(b["left"]), float(b["top"])
    bx2, by2 = bx1 + float(b["width"]), by1 + float(b["height"])
    return max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(0.0, min(ay2, by2) - max(ay1, by1))


def _iou(a: dict[str, Any], b: dict[str, Any]) -> float:
    inter = _intersection(a, b)
    if inter <= 0:
        return 0.0
    union = _box_area(a) + _box_area(b) - inter
    return inter / union if union > 0 else 0.0


# Plastic Wrapper / Cellophane often fire on bottles, cans, and bags.
_GENERIC_FILM = {"Plastic Wrapper", "Plastic Cellophane"}
_TALL_WASTE = {
    "Plastic Bottle",
    "Glass Bottle",
    "Can",
    "Plastic Cup",
    "Styro Cup",
    "Paper Drink Carton",
}
_BAG_WASTE = {"Plastic Bag", "Ecobag", "Paper Bag"}
_CLASS_MIN_CONF = {
    "Plastic Wrapper": 0.86,
    "Plastic Cellophane": 0.88,
    "Styro Cup": 0.75,
    "Face Mask": 0.88,
}
# Higher wins when two labels land on the same object.
_CLASS_PRIORITY = {
    "Plastic Bottle": 3,
    "Glass Bottle": 3,
    "Can": 3,
    "Plastic Cup": 3,
    "Styro Cup": 3,
    "Paper Drink Carton": 3,
    "Plastic Bag": 3,
    "Ecobag": 3,
    "Paper Bag": 3,
    "Face Mask": 3,
    "Plastic Wrapper": 2,
    "Plastic Cellophane": 2,
    "Cardboard": 1,
    "Styrofoam": 1,
}


def _box_aspect(box: dict[str, Any]) -> tuple[float, float, float]:
    width = max(float(box.get("width") or 0), 0.01)
    height = max(float(box.get("height") or 0), 0.01)
    return height / width, width, height


def _identity_remap_enabled() -> bool:
    return bool(getattr(settings, "class_identity_remap", False))


def is_person_sized(box: dict[str, Any]) -> bool:
    """True when the box is a standing person or clothing, not a waste item.

    Telephoto frames make a real bottle or bag fill more of the picture.
    Those classes are kept unless the box is large enough to be a person.
    """
    width = float(box.get("width") or 0)
    height = float(box.get("height") or 0)
    if width <= 0 or height <= 0:
        return False
    aspect = height / max(width, 0.01)
    area = (width / 100.0) * (height / 100.0)
    label = canonical_waste_class(str(box.get("class") or ""))
    closeup = label in {
        "Can",
        "Cardboard",
        "Ecobag",
        "Glass Bottle",
        "Paper Bag",
        "Paper Drink Carton",
        "Plastic Bottle",
        "Plastic Cup",
        "Styro Cup",
        "Styrofoam",
    }
    if closeup:
        return height >= 55 and width >= 22 and aspect >= 1.15
    if height >= 28 and aspect >= 1.35:
        return True
    if height >= 22 and width >= 14 and aspect >= 1.2:
        return True
    if area >= 0.08 and aspect >= 1.15:
        return True
    if label == "Face Mask" and (width >= 16 or height >= 16):
        return True
    if label in _GENERIC_FILM and aspect >= 1.4 and height >= 18:
        return True
    return False


def refine_waste_class(box: dict[str, Any]) -> str | None:
    """Drop unreliable labels. Identity remaps are optional and off by default."""
    label = canonical_waste_class(str(box.get("class") or ""))
    if not label:
        return None
    conf = float(box.get("confidence") or 0)
    aspect, width, height = _box_aspect(box)
    area = (width / 100.0) * (height / 100.0)

    # Person / clothing often fires as film covering a large share of the frame.
    if area > 0.10 and label in _GENERIC_FILM:
        return None

    # Weak wrapper scores are the usual bottle/can mix-up. Keep only strong film.
    if label in _GENERIC_FILM:
        if conf < _CLASS_MIN_CONF.get(label, 0.82):
            return None
        return label

    # Needle-thin bags are almost always a person, pole, or bottle.
    if label in _BAG_WASTE and aspect >= 2.6 and width <= 10.0:
        return None

    if not _identity_remap_enabled():
        return label

    if label in {"Styro Cup", "Plastic Cup"} and aspect < 0.85:
        if label == "Styro Cup" and area >= 0.012:
            return "Styrofoam"
        return None

    # Standing snack packs are often called Cardboard. Sheets are wider/flatter.
    if label == "Cardboard" and aspect >= 1.55 and width <= 12.0:
        return "Plastic Wrapper"

    # Close-up juice cartons are scored as Plastic Bottle by the current weights.
    if label == "Plastic Bottle" and 2.1 <= aspect <= 2.7 and 6.5 <= width <= 9.5:
        return "Paper Drink Carton"

    # Clean rectangular trays are cardboard clamshells, not foam chunks.
    if label == "Styrofoam" and 0.75 <= aspect <= 1.35 and width >= 8.0 and height >= 8.0:
        return "Cardboard"

    return label


def apply_class_refinement(
    boxes: list[dict[str, Any]],
    review_out: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Rewrite/drop misclassified boxes, then prefer specific classes over film.

    Dropped known classes are not sent to missed-detection review. That queue
    is only for objects outside the 13 dataset classes.
    """
    refined: list[dict[str, Any]] = []
    for box in boxes:
        if is_person_sized(box):
            log_rejected(
                str(box.get("camera_id") or "-"),
                str(box.get("class") or "unknown"),
                float(box.get("confidence") or 0),
                "person_sized",
            )
            continue
        label = refine_waste_class(box)
        if not label:
            score = float(box.get("confidence") or 0)
            log_rejected(
                str(box.get("camera_id") or "-"),
                str(box.get("class") or "unknown"),
                score,
                "below_80" if score < MIN_DETECT_CONF or score > MAX_DETECT_CONF else "unreliable_class",
            )
            continue
        box["class"] = label
        box["raw_class"] = label.lower()
        box["severity"] = SEVERITY.get(label.lower(), box.get("severity") or "alert")
        refined.append(box)
    ranked = sorted(refined, key=lambda item: item["confidence"], reverse=True)
    kept: list[dict[str, Any]] = []
    for box in ranked:
        skip = False
        replace_at: int | None = None
        box_rank = _CLASS_PRIORITY.get(box["class"], 2)
        for index, prev in enumerate(kept):
            if _iou(box, prev) < 0.35:
                continue
            prev_rank = _CLASS_PRIORITY.get(prev["class"], 2)
            if box_rank < prev_rank:
                skip = True
                break
            if box_rank > prev_rank:
                replace_at = index
                break
            skip = True
            break
        if skip:
            continue
        if replace_at is not None:
            kept[replace_at] = box
        else:
            kept.append(box)
    return _dedupe_boxes(kept)


def predict_frame_boxes(
    model,
    frame,
    conf_min: float,
    class_names: list[str],
    iou: float = 0.50,
    mode: str | None = None,
    timing: dict[str, Any] | None = None,
    review_out: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Run one ONNX model and map boxes to the full frame.

    Modes: full_frame, tiles_2x2, full_plus_tiles (two_strip alias).
    Thresholds and imgsz stay the same.
    """
    frame_h, frame_w = frame.shape[:2]
    regions = inference_regions(frame_w, frame_h, mode)
    boxes: list[dict[str, Any]] = []
    crop_ms: list[float] = []
    t_predict = time.perf_counter()
    for x0, y0, x1, y1 in regions:
        crop = frame[y0:y1, x0:x1]
        t_crop = time.perf_counter()
        results = model.predict(
            crop,
            conf=conf_min,
            iou=iou,
            imgsz=int(settings.imgsz) if int(settings.imgsz) > 0 else 640,
            agnostic_nms=False,
            max_det=50,
            verbose=False,
        )
        crop_ms.append((time.perf_counter() - t_crop) * 1000)
        if not results or results[0].boxes is None:
            continue
        for box in results[0].boxes:
            score = float(box.conf[0])
            if score < conf_min:
                continue
            cls_id = int(box.cls[0])
            if cls_id < 0 or cls_id >= len(class_names):
                continue
            lx1, ly1, lx2, ly2 = (float(v) for v in box.xyxy[0].tolist())
            gx1, gy1 = x0 + lx1, y0 + ly1
            gw, gh = lx2 - lx1, ly2 - ly1
            label = canonical_waste_class(class_names[cls_id])
            if not label:
                continue
            raw = label.lower()
            boxes.append(
                {
                    "id": f"yolo-{cls_id}-{int(gx1)}-{int(gy1)}",
                    "class": label,
                    "raw_class": raw,
                    "confidence": round(score, 4),
                    "severity": SEVERITY.get(raw, "alert"),
                    "variant": None,
                    "left": round(gx1 / frame_w * 100, 2),
                    "top": round(gy1 / frame_h * 100, 2),
                    "width": round(gw / frame_w * 100, 2),
                    "height": round(gh / frame_h * 100, 2),
                }
            )
    predict_ms = (time.perf_counter() - t_predict) * 1000
    t_refine = time.perf_counter()
    refined = apply_class_refinement(boxes, review_out)
    refine_ms = (time.perf_counter() - t_refine) * 1000
    if timing is not None:
        timing["n_regions"] = len(regions)
        timing["crop_ms"] = [round(ms, 1) for ms in crop_ms]
        timing["predict_ms"] = round(predict_ms, 1)
        timing["refine_ms"] = round(refine_ms, 1)
        timing["raw_boxes"] = len(boxes)
        timing["refined_boxes"] = len(refined)
    return refined


class _DetBatch:
    """Detections in the shape Ultralytics ByteTrack expects."""

    def __init__(self, xywh, conf, cls):
        self.xywh = np.asarray(xywh, dtype=np.float32).reshape(-1, 4)
        self.conf = np.asarray(conf, dtype=np.float32).reshape(-1)
        self.cls = np.asarray(cls, dtype=np.float32).reshape(-1)

    def __len__(self) -> int:
        return int(self.conf.shape[0])

    def __getitem__(self, mask: np.ndarray) -> "_DetBatch":
        return _DetBatch(self.xywh[mask], self.conf[mask], self.cls[mask])


def track_frame_boxes(
    model,
    frame,
    conf_min: float,
    iou: float,
    class_names: list[str],
    tracker: Any | None = None,
    inference_lock: Lock | None = None,
    mode: str | None = None,
    timing: dict[str, Any] | None = None,
    review_out: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Detect on tiles so small waste stays above the cutoff, then attach ByteTrack IDs.

    The box coordinates always come from this frame's detections. ByteTrack only
    supplies the persistent ID. Pass a per-stream tracker — never share trackers
    across unrelated lenses/cameras.
    """
    lock = inference_lock or _inference_lock
    predict_timing: dict[str, Any] = {} if timing is not None else {}
    with lock:
        boxes = predict_frame_boxes(
            model,
            frame,
            conf_min,
            class_names,
            iou=iou,
            mode=mode,
            timing=predict_timing if timing is not None else None,
            review_out=review_out,
        )
    t_track = time.perf_counter()
    frame_h, frame_w = frame.shape[:2]
    xywh = []
    confs = []
    clss = []
    for box in boxes:
        bw = float(box["width"]) / 100.0 * frame_w
        bh = float(box["height"]) / 100.0 * frame_h
        cx = float(box["left"]) / 100.0 * frame_w + bw / 2.0
        cy = float(box["top"]) / 100.0 * frame_h + bh / 2.0
        xywh.append([cx, cy, max(bw, 1.0), max(bh, 1.0)])
        confs.append(box["confidence"])
        clss.append(class_names.index(box["class"]) if box["class"] in class_names else 0)
    batch = _DetBatch(xywh, confs, clss) if boxes else _DetBatch(np.zeros((0, 4)), [], [])
    byte_tracker = tracker if tracker is not None else new_byte_tracker()
    tracked = byte_tracker.update(batch, img=frame)
    # Ultralytics STrack.result: xyxy(4) + track_id + score + cls + idx
    id_by_idx: dict[int, int] = {}
    if tracked is not None and len(tracked):
        for row in np.atleast_2d(tracked):
            if len(row) < 8:
                continue
            det_idx = int(row[7])
            track_id = int(row[4])
            if det_idx >= 0:
                id_by_idx[det_idx] = track_id
    for index, box in enumerate(boxes):
        track_id = id_by_idx.get(index)
        # Fallback: match by IoU when idx mapping misses (NMS / tile edge cases).
        if track_id is None and tracked is not None and len(tracked):
            track_id = _match_track_id_by_iou(box, tracked, frame_w, frame_h)
        # New objects stay unactivated on ByteTrack's first frame — still attach the id.
        if track_id is None:
            track_id = _match_track_id_from_stracks(box, byte_tracker, frame_w, frame_h)
        box["track_id"] = track_id
        if track_id is not None:
            box["id"] = f"track-{track_id}"
        box["confirmed"] = False
        box["frames"] = 1
    if timing is not None:
        timing.update(predict_timing)
        timing["track_ms"] = round((time.perf_counter() - t_track) * 1000, 1)
        timing["n_tracks"] = sum(1 for box in boxes if box.get("track_id") is not None)
    return boxes


def _match_track_id_by_iou(
    box: dict[str, Any],
    tracked: np.ndarray,
    frame_w: float,
    frame_h: float,
) -> int | None:
    """Assign a track id by best IoU when ByteTrack idx mapping is missing."""
    bl = float(box.get("left") or 0) / 100.0 * frame_w
    bt = float(box.get("top") or 0) / 100.0 * frame_h
    bw = float(box.get("width") or 0) / 100.0 * frame_w
    bh = float(box.get("height") or 0) / 100.0 * frame_h
    bx2, by2 = bl + bw, bt + bh
    best_id = None
    best_iou = 0.25
    for row in np.atleast_2d(tracked):
        if len(row) < 5:
            continue
        x1, y1, x2, y2 = (float(v) for v in row[:4])
        inter_x1, inter_y1 = max(bl, x1), max(bt, y1)
        inter_x2, inter_y2 = min(bx2, x2), min(by2, y2)
        iw, ih = max(0.0, inter_x2 - inter_x1), max(0.0, inter_y2 - inter_y1)
        inter = iw * ih
        if inter <= 0:
            continue
        union = bw * bh + max(0.0, x2 - x1) * max(0.0, y2 - y1) - inter
        iou = inter / union if union > 0 else 0.0
        if iou > best_iou:
            best_iou = iou
            best_id = int(row[4])
    return best_id


def _strack_xyxy(track: Any) -> np.ndarray | None:
    xyxy = getattr(track, "xyxy", None)
    if xyxy is None:
        tlbr = getattr(track, "tlbr", None)
        if tlbr is None:
            return None
        xyxy = tlbr
    arr = np.asarray(xyxy, dtype=float).reshape(-1)
    if arr.size < 4:
        return None
    return arr[:4]


def _match_track_id_from_stracks(
    box: dict[str, Any],
    tracker: Any,
    frame_w: float,
    frame_h: float,
) -> int | None:
    """Use unactivated / lost ByteTrack ids so the HUD is not id-less for a frame."""
    stracks: list[Any] = []
    for attr in ("tracked_stracks", "lost_stracks"):
        stracks.extend(getattr(tracker, attr, None) or [])
    if not stracks:
        return None
    rows = []
    for st in stracks:
        xyxy = _strack_xyxy(st)
        track_id = getattr(st, "track_id", None)
        if xyxy is None or track_id is None:
            continue
        row = np.zeros(5, dtype=float)
        row[:4] = xyxy
        row[4] = float(track_id)
        rows.append(row)
    if not rows:
        return None
    return _match_track_id_by_iou(box, np.vstack(rows), frame_w, frame_h)


def load_stream_configs() -> list[StreamConfig]:
    return parse_detector_streams(
        streams_json=settings.detector_streams,
        camera_id=settings.camera_id,
        rtsp_url=settings.rtsp_url,
        go2rtc_frame_url=settings.go2rtc_frame_url,
        sector=settings.sector,
        tapo_user=settings.tapo_rtsp_user or os.environ.get("TAPO_RTSP_USER", ""),
        tapo_pass=settings.tapo_rtsp_pass or os.environ.get("TAPO_RTSP_PASS", ""),
        tapo_host=settings.tapo_host or os.environ.get("TAPO_HOST", ""),
        tapo_accounts={
            "TAPO2": (
                settings.tapo2_rtsp_user or os.environ.get("TAPO2_RTSP_USER", ""),
                settings.tapo2_rtsp_pass or os.environ.get("TAPO2_RTSP_PASS", ""),
                settings.tapo2_host or os.environ.get("TAPO2_HOST", ""),
            ),
        },
        go2rtc_base=settings.go2rtc_base,
        go2rtc_rtsp_base=settings.go2rtc_rtsp_base
        or os.environ.get("GO2RTC_RTSP_BASE", "rtsp://127.0.0.1:8561"),
    )


def _publish_stream(camera_id: str, publish: StreamPublishState) -> None:
    """Mirror primary stream into legacy _state for older clients."""
    with _lock:
        _stream_states[camera_id] = publish
        # Prefer CAM-01 for aggregate health; else first configured stream.
        primary = settings.camera_id.upper()
        if camera_id == primary or (
            primary not in _stream_states and camera_id == next(iter(_stream_states), "")
        ):
            _state["last_ms"] = publish.last_ms
            _state["last_boxes"] = list(publish.last_boxes)
            _state["raw_boxes"] = list(publish.raw_boxes)
            _state["filtered_boxes"] = list(publish.filtered_boxes)
            _state["last_error"] = publish.last_error
            _state["frames"] = publish.frames
            _state["last_jpeg"] = publish.last_jpeg
            _state["frame_id"] = publish.frame_id
            _state["frame_captured_at"] = publish.frame_captured_at
            _state["frame_w"] = publish.frame_w
            _state["frame_h"] = publish.frame_h
            _state["frame_source"] = publish.frame_source
            _state["motion"] = dict(publish.motion)
            _state["track_trace"] = list(publish.track_trace)


def _get_stream_publish(camera_id: str | None) -> tuple[str, StreamPublishState | None]:
    """Resolve a stream publish state. Never return another camera's boxes."""
    wanted = (camera_id or settings.camera_id or "CAM-01").strip().upper()
    with _lock:
        if wanted in _stream_states:
            return wanted, _stream_states[wanted]
    return wanted, None


def crop_confirmed_jpeg(frame, box, pad_ratio: float = 0.15) -> str | None:
    """Crop one confirmed box from this frame. The crop is not taken from a later frame."""
    if frame is None or not box:
        return None
    frame_h, frame_w = frame.shape[:2]
    left = float(box.get("left") or 0) / 100.0 * frame_w
    top = float(box.get("top") or 0) / 100.0 * frame_h
    width = float(box.get("width") or 0) / 100.0 * frame_w
    height = float(box.get("height") or 0) / 100.0 * frame_h
    if width < 1 or height < 1:
        return None
    pad_x = max(12.0, width * pad_ratio)
    pad_y = max(12.0, height * pad_ratio)
    x1 = max(0, int(round(left - pad_x)))
    y1 = max(0, int(round(top - pad_y)))
    x2 = min(frame_w, int(round(left + width + pad_x)))
    y2 = min(frame_h, int(round(top + height + pad_y)))
    if x2 <= x1 or y2 <= y1:
        return None
    crop = frame[y1:y2, x1:x2]
    ok, buf = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    if not ok:
        return None
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _center_distance(a: dict[str, Any], b: dict[str, Any]) -> float:
    ax = float(a["left"]) + float(a["width"]) / 2.0
    ay = float(a["top"]) + float(a["height"]) / 2.0
    bx = float(b["left"]) + float(b["width"]) / 2.0
    by = float(b["top"]) + float(b["height"]) / 2.0
    return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5


def _same_tracked_object(box: dict[str, Any], state: dict[str, Any]) -> bool:
    """True when a new track id is still the object we just lost."""
    prev = state.get("last_box")
    if not prev:
        return False
    if _iou(box, prev) >= 0.15:
        return True
    return _center_distance(box, prev) <= 18.0


def _box_snapshot(box: dict[str, Any]) -> dict[str, float]:
    return {
        "left": float(box.get("left") or 0),
        "top": float(box.get("top") or 0),
        "width": float(box.get("width") or 0),
        "height": float(box.get("height") or 0),
    }


def _record_debug(fields: dict[str, object]) -> None:
    print("[RECORD DEBUG]")
    for key, value in fields.items():
        print(f"{key}={value}")


def update_tracks(
    tracks: dict[int, dict[str, Any]],
    boxes: list[dict[str, Any]],
    now: float,
    min_frames: int,
    record_conf: float,
    lost_timeout_s: float | None = None,
) -> list[dict[str, Any]]:
    """Mark boxes confirmed only after this same track id is seen on enough frames.

    recorded is stored on the track id. A different track id is a different
    tracking event, even when the class and location match a recent save.
    """
    seen: set[int] = set()
    timeout = max(
        0.0,
        float(settings.track_lost_timeout_seconds if lost_timeout_s is None else lost_timeout_s),
    )
    for box in boxes:
        track_id = box.get("track_id")
        if track_id is not None:
            seen.add(track_id)
    for box in boxes:
        score = float(box.get("confidence") or 0)
        official = canonical_waste_class(str(box.get("class") or ""))
        if official:
            box["class"] = official
            box["raw_class"] = official.lower()
            box["suggested_class"] = official
            box["needs_label"] = False
        else:
            box["suggested_class"] = box.get("class")
            box["needs_label"] = True
        track_id = box.get("track_id")
        if track_id is None:
            box["confirmed"] = False
            box["frames"] = 1
            continue
        state = tracks.get(track_id)
        votes = state.get("class_votes") if state else None
        if not isinstance(votes, deque):
            votes = deque(maxlen=5)
        votes.append(str(box["class"]))
        if state is None:
            state = {
                "class": box["class"],
                "frames": 0,
                "recorded": False,
                "snapshot_saved": False,
                "first_seen": now,
                "best_conf": score,
                "class_votes": votes,
            }
        elif state["class"] != box["class"]:
            # Keep a stable class unless the new label is stronger or more specific.
            prev_conf = float(state.get("best_conf") or 0)
            prev_rank = _CLASS_PRIORITY.get(str(state["class"]), 2)
            new_rank = _CLASS_PRIORITY.get(str(box["class"]), 2)
            majority = max(set(votes), key=list(votes).count) if votes else box["class"]
            majority_n = list(votes).count(majority)
            genuine = (
                new_rank > prev_rank
                or score >= prev_conf + 0.12
                or (
                    not state.get("recorded")
                    and majority == box["class"]
                    and majority_n >= 3
                    and new_rank >= prev_rank
                )
            )
            if genuine:
                state["class"] = box["class"]
                if not state.get("recorded"):
                    state["frames"] = 0
            else:
                box["class"] = state["class"]
                box["raw_class"] = str(state["class"]).lower()
        state["class_votes"] = votes
        state["frames"] += 1
        state["last_seen"] = now
        state["last_box"] = _box_snapshot(box)
        if box["class"] == state["class"]:
            state["best_conf"] = max(float(state.get("best_conf") or 0), score)
        tracks[track_id] = state
        box["frames"] = state["frames"]
        box["confirmed"] = state["frames"] >= min_frames and score >= record_conf
        if (
            state["frames"] >= min_frames
            and score < record_conf
            and not state.get("recorded")
            and not state.get("threshold_logged")
        ):
            state["threshold_logged"] = True
            print(
                f"[detector] Track ID: {track_id} Class: {box['class']} "
                f"Confidence: {score:.4f} Frame confirmation: {state['frames']}/{min_frames} "
                f"Recorded: false Reason: confidence is below the recording threshold {record_conf}"
            )
    for track_id in list(tracks):
        if track_id in seen:
            continue
        last_seen = float(tracks[track_id].get("last_seen") or 0)
        if now - last_seen > timeout:
            del tracks[track_id]
    return boxes


def confirmed_events(
    tracks: dict[int, dict[str, Any]],
    boxes: list[dict[str, Any]],
    class_last_recorded: dict[str, float],
    now: float,
    min_frames: int,
    cooldown_s: float,
    record_conf: float,
    prevent_duplicate: bool = True,
) -> list[dict[str, Any]]:
    """One database event per track. Scores under record_conf are shown, not stored.

    cooldown_s is accepted so the existing detector setting can be passed through.
    The current save decision does not use it.
    """
    del cooldown_s
    events: list[dict[str, Any]] = []
    for box in boxes:
        track_id = box.get("track_id")
        if track_id is None or not box.get("confirmed"):
            continue
        if float(box.get("confidence") or 0) < record_conf:
            continue
        state = tracks.get(track_id)
        if state is None:
            continue
        if prevent_duplicate and (state.get("recorded") or state.get("snapshot_saved")):
            continue
        if state["frames"] < min_frames:
            continue
        events.append(box)
    return events


def boxes_from_result(result, conf_min: float) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if result.boxes is None or len(result.boxes) == 0:
        return out

    h, w = result.orig_shape[:2]
    for box in result.boxes:
        score = float(box.conf[0])
        if score < conf_min:
            continue
        cls_id = int(box.cls[0])
        names = _model_classes or ONNX_CLASSES
        if cls_id < 0 or cls_id >= len(names):
            continue
        label = canonical_waste_class(names[cls_id])
        if not label:
            continue
        raw = label.lower()
        x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
        out.append(
            {
                "id": f"yolo-{cls_id}-{int(x1)}-{int(y1)}",
                "class": label,
                "raw_class": raw,
                "confidence": round(score, 4),
                "severity": SEVERITY.get(raw, "alert"),
                "variant": "sand" if "net" in raw or "fishing" in raw else None,
                "left": round(x1 / w * 100, 2),
                "top": round(y1 / h * 100, 2),
                "width": round((x2 - x1) / w * 100, 2),
                "height": round((y2 - y1) / h * 100, 2),
            }
        )
    return out


def _box_track_key(box: dict[str, Any]) -> tuple[str, int, int]:
    """Class plus position rounded to 5% so the same object matches across frames."""
    return (
        str(box.get("class") or "").lower(),
        int(round(float(box.get("left") or 0) / 5.0) * 5),
        int(round(float(box.get("top") or 0) / 5.0) * 5),
    )


def smooth_boxes(history: deque, boxes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep a box only after it appears in at least 3 of the last 5 frames."""
    history.append(boxes)
    counts: dict[tuple[str, int, int], int] = {}
    latest: dict[tuple[str, int, int], dict[str, Any]] = {}
    for frame_boxes in history:
        seen: set[tuple[str, int, int]] = set()
        for box in frame_boxes:
            key = _box_track_key(box)
            if key in seen:
                continue
            seen.add(key)
            counts[key] = counts.get(key, 0) + 1
            latest[key] = box
    return [latest[key] for key, count in counts.items() if count >= 3]


def summarize(boxes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by: dict[str, dict[str, Any]] = {}
    for b in boxes:
        key = b["class"]
        prev = by.get(key) or {
            "class": key,
            "confidence": 0.0,
            "count": 0,
            "severity": b.get("severity") or "alert",
        }
        prev["count"] += 1
        prev["confidence"] = max(prev["confidence"], b["confidence"])
        by[key] = prev
    return list(by.values())


def _fallback_detection_settings() -> dict[str, Any]:
    return {
        "enabled": True,
        "confidence": float(settings.conf),
        "interval": 1,
        "classes": set(ONNX_CLASSES),
        "record_conf": float(settings.record_conf),
        "min_frames": int(settings.min_confirmation_frames),
        "track_lost_timeout": float(settings.track_lost_timeout_seconds),
        "prevent_duplicate": True,
        "save_snapshots": True,
        "review_conf": 0.50,
    }


_DETECTION_SETTINGS_LOCK = Lock()
_DETECTION_SETTINGS_CACHE: dict[str, Any] | None = None
_DETECTION_SETTINGS_AT = 0.0


def _refresh_detection_settings(
    client: httpx.Client,
    current: dict[str, Any],
    fetched_at: float,
) -> tuple[dict[str, Any], float]:
    """Pull the Detection tab. Keep the last good values if Laravel is down."""
    global _DETECTION_SETTINGS_CACHE, _DETECTION_SETTINGS_AT
    now = time.time()
    with _DETECTION_SETTINGS_LOCK:
        if _DETECTION_SETTINGS_AT and now - _DETECTION_SETTINGS_AT < 8.0:
            return (_DETECTION_SETTINGS_CACHE or current), _DETECTION_SETTINGS_AT
        if now - fetched_at < 2.0:
            return current, fetched_at
        # Claim the slot so the other three streams do not stampede Laravel.
        _DETECTION_SETTINGS_AT = now
    try:
        response = client.get(
            f"{settings.api_base}/settings/detection",
            headers={"X-Detector-Key": settings.detector_key},
            timeout=0.4,
        )
        if response.status_code != 200:
            with _DETECTION_SETTINGS_LOCK:
                _DETECTION_SETTINGS_AT = now
            return current, now
        body = response.json()
        confidence = body.get("confidence")
        confidence = float(settings.conf if confidence is None else confidence)
        interval = int(body.get("interval") or 1)
        classes = body.get("classes")
        if not isinstance(classes, list):
            classes = list(ONNX_CLASSES)
        recording = body.get("recording") if isinstance(body.get("recording"), dict) else {}
        record_conf = recording.get("record_confidence", settings.record_conf)
        min_frames = recording.get("min_confirmation_frames", settings.min_confirmation_frames)
        lost_timeout = recording.get("track_lost_timeout", settings.track_lost_timeout_seconds)
        parsed = {
            "enabled": bool(body.get("enabled", True)),
            "confidence": min(MAX_DETECT_CONF, max(MIN_DETECT_CONF, confidence)),
            "interval": min(30, max(1, interval)),
            "classes": {str(name) for name in classes},
            "record_conf": min(MAX_DETECT_CONF, max(MIN_DETECT_CONF, float(record_conf))),
            "min_frames": min(30, max(1, int(min_frames))),
            "track_lost_timeout": min(60.0, max(0.0, float(lost_timeout))),
            "prevent_duplicate": bool(recording.get("prevent_duplicate", True)),
            "save_snapshots": bool(recording.get("save_snapshots", True)),
            "review_conf": min(
                MIN_DETECT_CONF - 0.01,
                max(MIN_PROPOSAL_CONF, float(body.get("review_confidence", 0.50))),
            ),
        }
        with _DETECTION_SETTINGS_LOCK:
            _DETECTION_SETTINGS_CACHE = parsed
            _DETECTION_SETTINGS_AT = now
        return parsed, now
    except Exception:  # noqa: BLE001
        with _DETECTION_SETTINGS_LOCK:
            _DETECTION_SETTINGS_AT = now
        return current, now


def _class_allowed(label: str, allowed: set[str]) -> bool:
    if not allowed:
        return True
    name = str(label or "").strip()
    if name in allowed:
        return True
    lower_map = {str(item).strip().lower(): True for item in allowed}
    return name.lower() in lower_map


def _overlay_confidence_floor(live: dict[str, Any]) -> float:
    """Minimum confidence to draw boxes. Saved settings apply, clamped to 80–98%."""
    live_floor = float(live.get("confidence", settings.conf))
    return min(MAX_DETECT_CONF, max(MIN_DETECT_CONF, live_floor))


def _hud_allowed_classes(live: dict[str, Any]) -> set[str]:
    """Only the 13 CCTV classes can be drawn or recorded."""
    del live
    return set(ONNX_CLASSES)


def _proposal_confidence_floor() -> float:
    return max(MIN_PROPOSAL_CONF, float(settings.proposal_conf))


def _apply_detection_settings(
    boxes: list[dict[str, Any]],
    live: dict[str, Any],
    include_provisional: bool | None = None,
) -> list[dict[str, Any]]:
    """Keep dataset-class boxes whose confidence is inside 80–98%."""
    del include_provisional
    allowed = _hud_allowed_classes(live)
    floor = _overlay_confidence_floor(live)
    kept: list[dict[str, Any]] = []
    for box in boxes:
        if not _class_allowed(str(box.get("class") or ""), allowed):
            continue
        score = float(box.get("confidence") or 0)
        class_floor = _CLASS_MIN_CONF.get(str(box.get("class") or ""), floor)
        solid = max(floor, class_floor, MIN_DETECT_CONF)
        if MIN_DETECT_CONF <= score <= MAX_DETECT_CONF and score >= solid:
            box["provisional"] = False
            kept.append(box)
            continue
        log_rejected(
            str(box.get("camera_id") or "-"),
            str(box.get("class") or "unknown"),
            score,
            "outside_80_98",
        )
    return kept


def _review_confidence_floor(live: dict[str, Any]) -> float:
    live_floor = _overlay_confidence_floor(live)
    review_floor = float(live.get("review_conf", 0.50))
    return min(live_floor - 0.01, max(MIN_PROPOSAL_CONF, review_floor))


def _low_confidence_review_boxes(
    boxes: list[dict[str, Any]],
    live: dict[str, Any],
) -> list[dict[str, Any]]:
    """Known-class boxes below the live 80% floor, at or above the review floor.

    These are queued for Missed Detection Review. They are not live detections.
    """
    allowed = _hud_allowed_classes(live)
    live_floor = _overlay_confidence_floor(live)
    review_floor = _review_confidence_floor(live)
    kept: list[dict[str, Any]] = []
    for box in boxes:
        label = canonical_waste_class(str(box.get("class") or "")) or str(box.get("class") or "")
        if not _class_allowed(label, allowed):
            continue
        score = float(box.get("confidence") or 0)
        if review_floor <= score < live_floor:
            kept.append(box)
    return kept


def publish_overlay_boxes(
    camera_id: str,
    publish: StreamPublishState,
    boxes: list[dict[str, Any]],
    *,
    frame: np.ndarray | None,
    frame_id: int | None,
    captured_at: float | None,
    inference_ms: int,
    loop_t0: float,
    infer_count: int,
    infer_window_t0: float,
    go2rtc_src: str = "",
    hud_conf: float | None = None,
) -> None:
    """Push boxes + annotated frame before Laravel I/O (HUD updates immediately)."""
    now_wall = time.time()
    now_perf = time.perf_counter()
    publish.last_boxes = list(boxes)
    publish.frame_id = frame_id
    publish.frame_captured_at = captured_at
    publish.last_ms = inference_ms
    publish.overlay_published_at = now_wall
    publish.go2rtc_src = go2rtc_src
    publish.connected = True
    publish.hud_conf = float(settings.conf if hud_conf is None else hud_conf)
    # loop_t0 is perf_counter from the start of this iteration.
    publish.detect_to_publish_ms = max(0, int((now_perf - loop_t0) * 1000))
    elapsed = max(1e-3, now_wall - infer_window_t0)
    publish.inference_fps = round(infer_count / elapsed, 2)
    publish.last_error = None
    if frame is not None:
        fh, fw = frame.shape[:2]
        publish.frame_w = fw
        publish.frame_h = fh
        annotated = draw_detection_boxes(frame, boxes)
        jpeg = encode_jpeg(annotated, max_width=960, quality=72)
        if jpeg:
            publish.annotated_jpeg = jpeg
            publish.last_jpeg = jpeg
    _publish_stream(camera_id, publish)


def stream_worker_loop(cfg: StreamConfig, model, model_label: str) -> None:
    """Independent detection loop for one camera/lens stream."""
    camera_id = cfg.stream_key
    publish = StreamPublishState(ready=True)
    reader = LatestFrameReader(
        name=camera_id,
        stop_event=_stop,
        reconnect_s=settings.stream_reconnect_s,
        capture_interval_s=settings.stream_capture_interval_s,
    )
    reader.start(rtsp_url=cfg.rtsp_url, jpeg_url=cfg.jpeg_url)
    tracker = new_byte_tracker()
    tracks: dict[int, dict[str, Any]] = {}
    class_last_recorded: dict[str, float] = {}
    pending_saves: dict[int, dict[str, Any]] = {}
    last_frame_id: int | None = None
    consecutive_misses = 0
    tracker_session = f"{camera_id}-{int(time.time())}"
    live_detection = _fallback_detection_settings()
    settings_fetched_at = 0.0
    infer_count = 0
    infer_window_t0 = time.time()
    last_overlay_publish_at = 0.0
    scene_motion = SceneMotion(
        min_area=settings.motion_min_area,
        history=settings.motion_history,
        var_threshold=settings.motion_var_threshold,
        detect_shadows=settings.motion_detect_shadows,
        morph_kernel=settings.motion_morph_kernel,
        learning_rate=settings.motion_learning_rate,
    )
    presence_book = PresenceBook(settings.absence_frames)
    motion_box_fraction = max(0.0, float(settings.motion_box_fraction))
    last_unfamiliar_at = time.time()
    last_lowconf_at = 0.0
    print(f"[detector] stream {camera_id} · src={cfg.go2rtc_src} · session {tracker_session}")
    _publish_stream(camera_id, publish)

    with httpx.Client(timeout=25.0) as client:
        while not _stop.is_set():
            t0 = time.perf_counter()
            live_detection, settings_fetched_at = _refresh_detection_settings(
                client,
                live_detection,
                settings_fetched_at,
            )
            if not live_detection.get("enabled", True):
                frame, _frame_id, _captured_at = reader.latest()
                publish.connected = bool(reader.connected and frame is not None)
                publish.last_boxes = []
                publish.raw_boxes = []
                publish.filtered_boxes = []
                publish.annotated_jpeg = None
                publish.motion = scene_motion.summary() if hasattr(scene_motion, "summary") else {}
                publish.last_error = None
                if tracks or pending_saves:
                    tracks.clear()
                    pending_saves.clear()
                    tracker = new_byte_tracker()
                _publish_stream(camera_id, publish)
                _stop.wait(0.25)
                continue
            frame, frame_id, captured_at = reader.latest()
            publish.connected = reader.connected
            publish.frame_source = "rtsp" if cfg.rtsp_url else "jpeg"
            if frame is None or frame_id is None:
                consecutive_misses += 1
                publish.connected = False
                # Only reset tracker / motion after a prolonged outage.
                if consecutive_misses >= max(1, int(settings.motion_reset_after_misses)):
                    scene_motion.reset()
                    tracker = new_byte_tracker()
                    tracks.clear()
                    consecutive_misses = 0
                # Drop stale HUD boxes when the stream goes dark.
                if consecutive_misses >= 3 and (
                    publish.last_boxes or publish.annotated_jpeg
                ):
                    publish.last_boxes = []
                    publish.annotated_jpeg = None
                    publish.overlay_published_at = time.time()
                publish.last_error = reader.last_error or "waiting for frame"
                _publish_stream(camera_id, publish)
                _stop.wait(0.02)
                continue
            if frame_id == last_frame_id:
                _stop.wait(0.02)
                continue
            # Brief gaps must NOT wipe ByteTrack — that drops track IDs.
            if consecutive_misses > 0:
                consecutive_misses = 0
            last_frame_id = frame_id
            publish.connected = True
            publish.go2rtc_src = cfg.go2rtc_src
            # Rate limit by INTERVAL_S only (settings interval capped at 1 for HUD).
            gap = max(0.15, float(settings.interval_s))
            if last_overlay_publish_at and (time.time() - last_overlay_publish_at) < gap:
                _stop.wait(0.01)
                continue

            vis = frame
            h, w = vis.shape[:2]
            if w > 960:
                vis = cv2.resize(vis, (960, int(h * 960 / w)))
            ok, buf = cv2.imencode(".jpg", vis, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            if ok:
                with _lock:
                    _state["last_jpeg"] = buf.tobytes()

            try:
                t_infer0 = time.perf_counter()
                # YOLO searches at proposal_conf (recall). HUD still hides scores
                # below the saved floor (min 70%). Recording stays on record_conf.
                hud_conf = _overlay_confidence_floor(live_detection)
                proposal = min(
                    hud_conf,
                    max(MIN_PROPOSAL_CONF, float(settings.proposal_conf)),
                )
                review_out: list[dict[str, Any]] = []
                raw_boxes = track_frame_boxes(
                    model,
                    frame,
                    proposal,
                    settings.iou,
                    _model_classes,
                    tracker=tracker,
                    inference_lock=_inference_lock,
                    review_out=review_out,
                )
                for box in raw_boxes:
                    box["camera_id"] = camera_id
                    box["stream_src"] = cfg.go2rtc_src
                    box["frame_id"] = frame_id
                overlay_boxes = filter_overlay_boxes(raw_boxes)
                filtered = _apply_detection_settings(
                    overlay_boxes,
                    live_detection,
                )
                review_candidates = _low_confidence_review_boxes(
                    overlay_boxes,
                    live_detection,
                )
                now = time.time()
                boxes = update_tracks(
                    tracks,
                    filtered,
                    now,
                    int(live_detection["min_frames"]),
                    float(live_detection["record_conf"]),
                    float(live_detection["track_lost_timeout"]),
                )
                annotate_detection_stages(boxes, tracks)
                for box in boxes:
                    box["camera_id"] = camera_id
                    box["stream_src"] = cfg.go2rtc_src
                    box["frame_id"] = frame_id
                hud_boxes_out = list(boxes)
                seen = {
                    (round(float(b.get("left") or 0), 2), round(float(b.get("top") or 0), 2), str(b.get("class") or ""))
                    for b in hud_boxes_out
                }
                for box in review_candidates:
                    key = (
                        round(float(box.get("left") or 0), 2),
                        round(float(box.get("top") or 0), 2),
                        str(box.get("class") or ""),
                    )
                    if key in seen:
                        continue
                    drawn = dict(box)
                    drawn["provisional"] = True
                    drawn["camera_id"] = camera_id
                    drawn["stream_src"] = cfg.go2rtc_src
                    drawn["frame_id"] = frame_id
                    hud_boxes_out.append(drawn)
                    seen.add(key)
                infer_ms = int((time.perf_counter() - t_infer0) * 1000)
                infer_count += 1
                for rejected in review_out:
                    log_rejected(
                        camera_id,
                        str(rejected.get("class") or "unknown"),
                        float(rejected.get("confidence") or 0),
                        "uncertain_class",
                        infer_ms,
                    )
                if infer_count % 30 == 0:
                    print(
                        f"[detector] {camera_id} infer_ms={infer_ms} "
                        f"raw={len(raw_boxes)} kept={len(filtered)} "
                        f"uncertain={len(review_out)}"
                    )

                # Motion after YOLO (never gates inference), before HUD so the
                # same frame_id carries motion flags on each box.
                motion = scene_motion.analyze(frame)
                motion_mask = motion.mask
                for box in hud_boxes_out:
                    box["motion"] = (
                        scene_motion.fraction(motion_mask, box) >= motion_box_fraction
                    )
                publish.motion = motion.summary()
                if settings.motion_debug:
                    track_ids = [
                        box.get("track_id")
                        for box in boxes
                        if box.get("track_id") is not None
                    ]
                    print(
                        f"[MOTION DEBUG {camera_id}] "
                        f"has_motion={motion.has_motion} "
                        f"regions={motion.region_count} "
                        f"yolo_boxes={len(raw_boxes)} "
                        f"tracked={len(track_ids)}"
                    )

                # HUD first (boxes + optional annotated JPEG) — before Laravel I/O.
                publish_overlay_boxes(
                    camera_id,
                    publish,
                    hud_boxes_out,
                    frame=frame if settings.annotate_frames else None,
                    frame_id=frame_id,
                    captured_at=captured_at,
                    inference_ms=infer_ms,
                    loop_t0=t0,
                    infer_count=infer_count,
                    infer_window_t0=infer_window_t0,
                    go2rtc_src=cfg.go2rtc_src,
                    hud_conf=hud_conf,
                )
                last_overlay_publish_at = time.time()

                events = confirmed_events(
                    tracks,
                    boxes,
                    class_last_recorded,
                    now,
                    int(live_detection["min_frames"]),
                    settings.detection_cooldown_seconds,
                    float(live_detection["record_conf"]),
                    bool(live_detection["prevent_duplicate"]),
                )
                for box in boxes:
                    if not box.get("confirmed"):
                        continue
                    track_id = box.get("track_id")
                    state = tracks.get(track_id) if track_id is not None else None
                    if state is None or state.get("debug_logged"):
                        continue
                    if live_detection["prevent_duplicate"] and (
                        state.get("recorded") or state.get("snapshot_saved")
                    ):
                        state["debug_logged"] = True
                        _record_debug({
                            "camera_id": camera_id,
                            "class": box.get("class"),
                            "confidence": box.get("confidence"),
                            "track_id": track_id,
                            "confirmation": f"{state.get('frames')}/{settings.min_confirmation_frames}",
                            "confirmed": "true",
                            "recorded": "true",
                            "duplicate_check": "REJECT",
                            "reason": "already_recorded",
                        })
                for row in events:
                    if canonical_waste_class(str(row.get("class") or "")) not in ONNX_CLASSES:
                        continue
                    track_id = row.get("track_id")
                    state = tracks.get(track_id) if track_id is not None else None
                    if track_id is None or state is None or track_id in pending_saves:
                        continue
                    if live_detection["prevent_duplicate"] and state.get("recorded"):
                        continue
                    state["recorded"] = True
                    state["snapshot_saved"] = bool(live_detection["save_snapshots"])
                    state["debug_logged"] = True
                    pending_saves[track_id] = {
                        "class": row["class"],
                        "confidence": row["confidence"],
                        "count": 1,
                        "severity": row["severity"],
                        "sector": cfg.sector,
                        "subtitle": (
                            f"Track {track_id} · YOLO · {camera_id} · {cfg.go2rtc_src}"
                        ),
                        "frame_id": frame_id,
                        "left": row.get("left"),
                        "top": row.get("top"),
                        "width": row.get("width"),
                        "height": row.get("height"),
                        "histogram": hue_histogram(frame, row),
                        "snapshot": (
                            crop_confirmed_jpeg(frame, row)
                            if live_detection["save_snapshots"]
                            else None
                        ),
                    }
                fh, fw = frame.shape[:2]
                ms = max(infer_ms, int((time.perf_counter() - t0) * 1000))
                # Refresh stages after confirmation/save flags may have changed.
                annotate_detection_stages(boxes, tracks)
                if settings.annotate_frames:
                    annotated = draw_detection_boxes(frame, boxes)
                    jpeg = encode_jpeg(annotated, max_width=960, quality=72)
                    if jpeg:
                        publish.annotated_jpeg = jpeg
                        publish.last_jpeg = jpeg
                else:
                    # Lightweight preview JPEG (no box burn-in) for /frame.jpeg.
                    jpeg = encode_jpeg(frame, max_width=640, quality=55)
                    if jpeg:
                        publish.last_jpeg = jpeg
                publish.last_ms = infer_ms
                publish.raw_boxes = raw_boxes
                publish.filtered_boxes = filtered
                publish.last_boxes = hud_boxes_out
                publish.frame_w = fw
                publish.frame_h = fh
                publish.frame_id = frame_id
                publish.frame_captured_at = captured_at
                publish.last_error = None
                publish.frames += 1
                publish.connected = True
                publish.motion = motion.summary()
                publish.track_trace = [
                    {
                        "track_id": tid,
                        "class": st.get("class"),
                        "confirmation": st.get("frames"),
                        "required": settings.min_confirmation_frames,
                        "recorded": bool(st.get("recorded")),
                        "saved_id": st.get("saved_id"),
                        "camera_id": camera_id,
                    }
                    for tid, st in tracks.items()
                ]
                _publish_stream(camera_id, publish)

                active_saved = {
                    tid: {
                        "detection_id": int(state["saved_id"]),
                        "box": state.get("last_box") or {},
                        "class": state.get("class"),
                    }
                    for tid, state in tracks.items()
                    if isinstance(state.get("saved_id"), int)
                }
                status_updates = presence_book.step(
                    active_saved,
                    motion_mask,
                    stream_ok=reader.connected,
                )

                unfamiliar_due = (
                    time.time() - last_unfamiliar_at
                    >= max(20.0, float(settings.unfamiliar_interval_s))
                )
                lowconf_due = (
                    time.time() - last_lowconf_at
                    >= max(20.0, float(settings.unfamiliar_interval_s))
                )
                if frame is not None and review_candidates and lowconf_due:
                    last_lowconf_at = time.time()
                    report_low_confidence_classes(
                        client,
                        camera_id,
                        frame,
                        review_candidates,
                    )

                if frame is not None and (pending_saves or unfamiliar_due):
                    last_unfamiliar_at = time.time()
                    review_unfamiliar_frame(
                        client,
                        camera_id,
                        frame,
                        boxes,
                        pending_saves,
                    )

                if pending_saves:
                    sending_ids = list(pending_saves)
                    response = client.post(
                        f"{settings.api_base}/detections/live",
                        json={
                            "camera_id": camera_id,
                            "boxes": boxes,
                            "inference_ms": ms,
                            "model": model_label,
                            "tracker_session": tracker_session,
                            "detections": list(pending_saves.values()),
                        },
                        headers={"X-Detector-Key": settings.detector_key},
                    )
                    if response.status_code not in (200, 201):
                        for track_id in sending_ids:
                            payload = pending_saves.get(track_id) or {}
                            state = tracks.get(track_id) or {}
                            _record_debug({
                                "camera_id": camera_id,
                                "class": payload.get("class"),
                                "confidence": payload.get("confidence"),
                                "track_id": track_id,
                                "confirmation": f"{state.get('frames')}/{settings.min_confirmation_frames}",
                                "confirmed": "true",
                                "recorded": "false",
                                "duplicate_check": "PASS",
                                "api": f"POST {settings.api_base}/detections/live",
                                "status": response.status_code,
                                "detection_id": "none",
                                "reason": response.text[:300],
                            })
                        raise RuntimeError(
                            f"detections/live HTTP {response.status_code} {response.text[:400]}"
                        )
                    body = response.json()
                    saved_ids: dict[int, int] = {}
                    for item in body.get("detections") or []:
                        track_match = None
                        subtitle = str(item.get("subtitle") or "")
                        if "Track " in subtitle:
                            try:
                                track_match = int(subtitle.split("Track ", 1)[1].split(" ", 1)[0])
                            except ValueError:
                                track_match = None
                        detection_id = item.get("id")
                        if track_match is not None and isinstance(detection_id, int):
                            saved_ids[track_match] = detection_id
                    recorded_now = []
                    for track_id in sending_ids:
                        payload = pending_saves.get(track_id) or {}
                        state = tracks.get(track_id)
                        detection_id = saved_ids.get(track_id)
                        _record_debug({
                            "camera_id": camera_id,
                            "class": payload.get("class"),
                            "confidence": payload.get("confidence"),
                            "track_id": track_id,
                            "confirmation": (
                                f"{(state or {}).get('frames')}/{settings.min_confirmation_frames}"
                            ),
                            "confirmed": "true",
                            "recorded": "false",
                            "duplicate_check": "PASS",
                            "api": f"POST {settings.api_base}/detections/live",
                            "status": response.status_code,
                            "detection_id": detection_id if detection_id is not None else "missing",
                            "reason": (
                                "saved"
                                if detection_id is not None
                                else "response_missing_detection_id"
                            ),
                        })
                        if detection_id is None or state is None:
                            continue
                        state["recorded"] = bool(live_detection["prevent_duplicate"])
                        state["snapshot_saved"] = bool(live_detection["save_snapshots"])
                        state["saved_id"] = detection_id
                        state["debug_logged"] = True
                        pending_saves.pop(track_id, None)
                        recorded_now.append((track_id, detection_id))
                    if recorded_now:
                        print(f"[detector] {camera_id} saved {recorded_now}")

                if status_updates:
                    try:
                        status_response = client.post(
                            f"{settings.api_base}/detections/live",
                            json={
                                "camera_id": camera_id,
                                "boxes": [],
                                "inference_ms": ms,
                                "model": model_label,
                                "tracker_session": tracker_session,
                                "detections": [],
                                "status_updates": status_updates,
                            },
                            headers={"X-Detector-Key": settings.detector_key},
                        )
                        if status_response.status_code not in (200, 201):
                            raise RuntimeError(
                                f"status HTTP {status_response.status_code} {status_response.text[:300]}"
                            )
                        print(f"[detector] {camera_id} presence {status_updates}")
                    except Exception as exc:  # noqa: BLE001
                        for row in status_updates:
                            watch = presence_book.watch.get(row.get("detection_id"))
                            if watch is not None and row.get("status") == "Confirmed Cleaned":
                                watch["sent"] = False
                        print(f"[detector] {camera_id} presence update failed: {exc}")
            except Exception as exc:  # noqa: BLE001
                publish.last_error = str(exc)
                _publish_stream(camera_id, publish)
                print(f"[detector] {camera_id} error: {exc}")

            # Rate limit is the INTERVAL_S gap at the start of the loop. Do not
            # sleep leftover time after a slow infer — that delays the next frame.


# Open-vocabulary prompts that are not in weights (4). Hits go to review, not detections.
UNFAMILIAR_PROMPTS = [
    "plastic bag",
    "shoe",
    "fishing net",
    "cigarette",
    "straw",
    "bottle cap",
    "rope",
    "tire",
    "electrical plug",
    "power adapter",
    "charger",
    "cable",
]
WORLD_WEIGHTS = Path(__file__).with_name("yolov8s-worldv2.pt")
_world_model = None
_world_disabled = False
_unfamiliar_seen: dict[tuple, float] = {}


def unfamiliar_prompts() -> list[str]:
    official = {_norm_class(name) for name in ONNX_CLASSES}
    return [prompt for prompt in UNFAMILIAR_PROMPTS if _norm_class(prompt) not in official]


def _load_world_model():
    global _world_model, _world_disabled
    if _world_model is not None or _world_disabled:
        return _world_model
    if not WORLD_WEIGHTS.is_file():
        _world_disabled = True
        print("[detector] unfamiliar scan off: yolov8s-worldv2.pt is missing")
        return None
    try:
        model = YOLO(str(WORLD_WEIGHTS))
        prompts = unfamiliar_prompts()
        if not prompts or not hasattr(model, "set_classes"):
            _world_disabled = True
            print("[detector] unfamiliar scan off: open-vocabulary model is unavailable")
            return None
        model.set_classes(prompts)
        _world_model = model
        print(f"[detector] unfamiliar prompts: {prompts}")
        return model
    except Exception as exc:  # noqa: BLE001
        _world_disabled = True
        print(f"[detector] unfamiliar scan off: {exc}")
        return None


def _unit_box(box: dict[str, Any]) -> dict[str, float]:
    left = float(box.get("left", box.get("x", 0)) or 0)
    top = float(box.get("top", box.get("y", 0)) or 0)
    width = float(box.get("width") or 0)
    height = float(box.get("height") or 0)
    if max(left, top, width, height) > 1:
        left, top, width, height = left / 100, top / 100, width / 100, height / 100
    return {"left": left, "top": top, "width": width, "height": height}


def _unfamiliar_proposals(frame) -> list[dict[str, Any]]:
    """Open-vocabulary hits that are not one of the 13 CCTV classes."""
    world = _load_world_model()
    prompts = unfamiliar_prompts()
    if world is None or not prompts or frame is None:
        return []
    height, width = frame.shape[:2]
    if width < 2 or height < 2:
        return []
    with _inference_lock:
        results = world.predict(
            frame,
            conf=MIN_DETECT_CONF,
            iou=0.50,
            imgsz=640,
            max_det=5,
            verbose=False,
        )
    if not results or results[0].boxes is None:
        return []
    official = {_norm_class(name) for name in ONNX_CLASSES}
    proposals: list[dict[str, Any]] = []
    for box in results[0].boxes:
        score = float(box.conf[0])
        if score < MIN_DETECT_CONF or score > MAX_DETECT_CONF:
            continue
        cls_id = int(box.cls[0])
        if cls_id < 0 or cls_id >= len(prompts):
            continue
        label = prompts[cls_id]
        if _norm_class(label) in official:
            continue
        x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
        proposal = {
            "label": label,
            "confidence": round(score, 4),
            "x": max(0.0, x1 / width),
            "y": max(0.0, y1 / height),
            "width": max(0.0, (x2 - x1) / width),
            "height": max(0.0, (y2 - y1) / height),
        }
        if proposal["width"] < 0.02 or proposal["height"] < 0.02:
            continue
        if proposal["x"] + proposal["width"] > 1 or proposal["y"] + proposal["height"] > 1:
            continue
        proposals.append(proposal)
    return proposals


def split_unfamiliar(
    proposals: list[dict[str, Any]],
    official_boxes: list[dict[str, Any]],
    iou_min: float = 0.45,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Separate objects the waste model did not box from boxes it named wrongly."""
    outside: list[dict[str, Any]] = []
    disputes: list[dict[str, Any]] = []
    for proposal in proposals:
        unit = _unit_box(proposal)
        if any(_iou(unit, _unit_box(known)) >= iou_min for known in official_boxes):
            disputes.append(proposal)
        else:
            outside.append(proposal)
    return outside, disputes


def drop_disputed_saves(
    pending_saves: dict[int, dict[str, Any]],
    disputes: list[dict[str, Any]],
    iou_min: float = 0.45,
) -> list[tuple[int, dict[str, Any], dict[str, Any]]]:
    """Hold back a live save when an unfamiliar object covers the same box.

    The unfamiliar score must be at least the waste score. A weaker open-vocabulary
    guess does not replace a CCTV-class detection.
    """
    dropped: list[tuple[int, dict[str, Any], dict[str, Any]]] = []
    for track_id, payload in list(pending_saves.items()):
        waste_score = float(payload.get("confidence") or 0)
        for dispute in disputes:
            if float(dispute.get("confidence") or 0) < max(MIN_DETECT_CONF, waste_score):
                continue
            if _iou(_unit_box(payload), _unit_box(dispute)) < iou_min:
                continue
            dropped.append((track_id, pending_saves.pop(track_id), dispute))
            break
    return dropped


def _post_review_proposal(
    client,
    camera_id: str,
    frame,
    proposal: dict[str, Any],
    reason: str,
) -> bool:
    unit = {
        "x": float(proposal.get("x", proposal.get("left", 0)) or 0),
        "y": float(proposal.get("y", proposal.get("top", 0)) or 0),
        "width": float(proposal.get("width") or 0),
        "height": float(proposal.get("height") or 0),
    }
    if max(unit.values()) > 1:
        unit = {key: value / 100.0 for key, value in unit.items()}
    label = str(proposal.get("label") or proposal.get("class") or "unrecognized")
    center_x = int((unit["x"] + unit["width"] / 2) * 8)
    center_y = int((unit["y"] + unit["height"] / 2) * 8)
    key = (camera_id, reason, label, center_x, center_y)
    now = time.time()
    if now - _unfamiliar_seen.get(key, 0) < 1200:
        return False
    jpeg = encode_jpeg(frame, max_width=960, quality=70)
    if not jpeg:
        return False
    response = client.post(
        f"{settings.api_base}/missed-detections/unfamiliar",
        data={
            "camera_id": camera_id,
            "label": label,
            "reason": reason,
            "confidence": str(proposal.get("confidence") or 0),
            "x": f"{unit['x']:.6f}",
            "y": f"{unit['y']:.6f}",
            "width": f"{unit['width']:.6f}",
            "height": f"{unit['height']:.6f}",
        },
        files={"image": ("frame.jpg", jpeg, "image/jpeg")},
        headers={"X-Detector-Key": settings.detector_key},
        timeout=20,
    )
    if response.status_code not in (200, 201):
        print(
            f"[detector] {camera_id} {reason} report "
            f"HTTP {response.status_code} {response.text[:200]}"
        )
        return False
    _unfamiliar_seen[key] = now
    print(f"[detector] {camera_id} queued {reason} {label}")
    return True


def _post_unfamiliar(client, camera_id: str, frame, proposal: dict[str, Any]) -> bool:
    return _post_review_proposal(client, camera_id, frame, proposal, "unfamiliar")


def report_low_confidence_classes(
    client,
    camera_id: str,
    frame,
    boxes: list[dict[str, Any]],
) -> None:
    """Queue known-class YOLO boxes that scored below the live detection floor."""
    if frame is None or not boxes:
        return
    try:
        posted = 0
        for box in boxes:
            if posted >= 3:
                break
            unit = _unit_box(box)
            if unit["width"] < 0.02 or unit["height"] < 0.02:
                continue
            if unit["left"] + unit["width"] > 1.000001 or unit["top"] + unit["height"] > 1.000001:
                continue
            label = canonical_waste_class(str(box.get("class") or "")) or str(box.get("class") or "")
            if not label:
                continue
            queued = _post_review_proposal(
                client,
                camera_id,
                frame,
                {
                    "label": label,
                    "confidence": round(float(box.get("confidence") or 0), 4),
                    "x": unit["left"],
                    "y": unit["top"],
                    "width": unit["width"],
                    "height": unit["height"],
                },
                "low_confidence",
            )
            if queued:
                posted += 1
    except Exception as exc:  # noqa: BLE001
        print(f"[detector] {camera_id} low-confidence review failed: {exc}")


def review_unfamiliar_frame(
    client,
    camera_id: str,
    frame,
    official_boxes: list[dict[str, Any]],
    pending_saves: dict[int, dict[str, Any]],
) -> None:
    """Send non-dataset objects to review. Do not save a waste row for those boxes."""
    try:
        proposals = _unfamiliar_proposals(frame)
        if not proposals:
            return
        outside, disputes = split_unfamiliar(proposals, official_boxes)
        for _track_id, payload, dispute in drop_disputed_saves(pending_saves, disputes):
            print(
                f"[detector] {camera_id} held {payload.get('class')} "
                f"for review as unfamiliar {dispute['label']}"
            )
            _post_unfamiliar(client, camera_id, frame, dispute)
        if outside:
            best = max(outside, key=lambda item: float(item["confidence"]))
            _post_unfamiliar(client, camera_id, frame, best)
    except Exception as exc:  # noqa: BLE001
        print(f"[detector] {camera_id} unfamiliar scan failed: {exc}")


def report_unfamiliar(client, camera_id: str, frame, official_boxes: list[dict[str, Any]]) -> None:
    """Queue one object the CCTV model cannot name. Never writes a live detection."""
    review_unfamiliar_frame(client, camera_id, frame, official_boxes, {})


def report_uncertain_classes(client, camera_id: str, frame, boxes: list[dict[str, Any]]) -> None:
    """Send a high-confidence box whose class was rejected. It is not drawn."""
    if frame is None or not boxes:
        return
    try:
        jpeg = None
        for box in boxes:
            if float(box.get("confidence") or 0) < MIN_DETECT_CONF:
                continue
            unit = _unit_box(box)
            if unit["width"] < 0.02 or unit["height"] < 0.02:
                continue
            if unit["left"] + unit["width"] > 1.000001 or unit["top"] + unit["height"] > 1.000001:
                continue
            label = str(box.get("class") or "unrecognized")
            center_x = int((unit["left"] + unit["width"] / 2) * 8)
            center_y = int((unit["top"] + unit["height"] / 2) * 8)
            key = (camera_id, "uncertain", label, center_x, center_y)
            now = time.time()
            if now - _unfamiliar_seen.get(key, 0) < 1200:
                continue
            if jpeg is None:
                jpeg = encode_jpeg(frame, max_width=960, quality=70)
            if not jpeg:
                return
            response = client.post(
                f"{settings.api_base}/missed-detections/unfamiliar",
                data={
                    "camera_id": camera_id,
                    "label": label,
                    "reason": "uncertain",
                    "confidence": str(round(float(box.get("confidence") or 0), 4)),
                    "x": f"{unit['left']:.6f}",
                    "y": f"{unit['top']:.6f}",
                    "width": f"{unit['width']:.6f}",
                    "height": f"{unit['height']:.6f}",
                },
                files={"image": ("frame.jpg", jpeg, "image/jpeg")},
                headers={"X-Detector-Key": settings.detector_key},
                timeout=20,
            )
            if response.status_code not in (200, 201):
                print(
                    f"[detector] {camera_id} uncertain class "
                    f"HTTP {response.status_code} {response.text[:200]}"
                )
                continue
            _unfamiliar_seen[key] = now
            print(f"[detector] {camera_id} queued uncertain class {label}")
    except Exception as exc:  # noqa: BLE001
        print(f"[detector] {camera_id} uncertain class report failed: {exc}")


def worker() -> None:
    catalog, _classes = load_dataset_catalog()
    print(f"[detector] datasets: {len(catalog)} (local-merged only)")
    for row in catalog:
        print(f"  · {row['name']} ({row['yaml']})")

    if not ONNX_WEIGHTS.is_file():
        raise SystemExit(f"missing ONNX weights: {ONNX_WEIGHTS}")
    print(f"[detector] loading YOLOv11 ONNX {ONNX_WEIGHTS}")
    providers = onnx_runtime_providers()
    print(f"[detector] onnxruntime providers: {providers or ['unavailable']}")
    if "CUDAExecutionProvider" not in providers:
        print("[detector] CUDA EP not available — using CPU inference")
    model = YOLO(str(ONNX_WEIGHTS), task="detect")
    model_label = f"YOLOv11n ONNX · {ONNX_WEIGHTS.name}"
    global _model_classes
    _model_classes = resolve_model_classes(model)
    print(f"[detector] dataset classes ({len(_model_classes)}): {_model_classes}")
    print(f"[detector] class_identity_remap: {bool(settings.class_identity_remap)}")
    print("[detector] live boxes require confidence 0.80–0.98")

    try:
        configs = [c for c in load_stream_configs() if c.enabled]
    except ValueError as exc:
        raise SystemExit(f"stream config error: {exc}") from exc
    if not configs:
        raise SystemExit("no enabled detector streams configured")

    global _stream_configs
    _stream_configs = configs

    print("[detector] startup (multi-stream)")
    print(f"  model: {ONNX_WEIGHTS}")
    print(f"  classes: {len(_model_classes)}")
    print(f"  conf: {settings.conf}")
    print(f"  proposal_conf: {settings.proposal_conf}")
    print(f"  record_conf: {settings.record_conf}")
    print(f"  iou: {settings.iou}")
    print(f"  min_confirmation_frames: {settings.min_confirmation_frames}")
    print(f"  detection_cooldown_seconds: {settings.detection_cooldown_seconds}")
    print(f"  track_lost_timeout_seconds: {settings.track_lost_timeout_seconds}")
    print(f"  tracker: bytetrack (per stream)")
    print(f"  detection_mode: {detection_mode()} (setting={settings.detection_mode})")
    print(f"  interval_s: {settings.interval_s}")
    print(f"  stream_capture_interval_s: {settings.stream_capture_interval_s}")
    print(f"  max_concurrent_inference: {settings.max_concurrent_inference}")
    print(f"  streams: {len(configs)}")
    for cfg in configs:
        has_rtsp = "yes" if cfg.rtsp_url else "jpeg-only"
        print(f"    · {cfg.camera_id} src={cfg.go2rtc_src} capture={has_rtsp} label={cfg.label}")

    _state["ready"] = True
    _state["catalog"] = catalog
    _state["model_label"] = model_label
    print(f"[detector] ready · {model_label}")

    threads: list[Thread] = []
    for cfg in configs:
        thread = Thread(
            target=stream_worker_loop,
            args=(cfg, model, model_label),
            name=f"yolo-{cfg.camera_id}",
            daemon=True,
        )
        thread.start()
        threads.append(thread)

    while not _stop.is_set():
        _stop.wait(0.5)
    for thread in threads:
        thread.join(timeout=3)



@asynccontextmanager
async def lifespan(_app: FastAPI):
    thread = Thread(target=worker, name="yolo-worker", daemon=True)
    thread.start()
    yield
    _stop.set()
    thread.join(timeout=5)
    global _rtsp_cap
    if _rtsp_cap is not None:
        _rtsp_cap.release()
        _rtsp_cap = None


app = FastAPI(title="TidalWatch YOLO Detector", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    with _lock:
        streams = {
            cam: {
                "connected": st.connected,
                "frames": st.frames,
                "last_ms": st.last_ms,
                "boxes": len(st.last_boxes),
                "error": st.last_error,
                "frame_id": st.frame_id,
                "frame_source": st.frame_source,
            }
            for cam, st in _stream_states.items()
        }
    return {
        "ok": True,
        "ready": _state["ready"],
        "frames": _state["frames"],
        "last_ms": _state["last_ms"],
        "boxes": len(_state["last_boxes"]),
        "error": _state["last_error"],
        "camera_id": settings.camera_id,
        "model": _state.get("model_label") or settings.model_name,
        "datasets": len(_state.get("catalog") or []),
        "detection_mode": detection_mode(),
        "frame_id": _state.get("frame_id"),
        "streams": streams,
        "configured": [
            {
                "camera_id": c.camera_id,
                "go2rtc_src": c.go2rtc_src,
                "label": c.label,
                "enabled": c.enabled,
                "has_rtsp": bool(c.rtsp_url),
            }
            for c in _stream_configs
        ],
    }


@app.get("/datasets")
def datasets():
    catalog, _classes = load_dataset_catalog()
    return {"count": len(catalog), "catalog": catalog}


def _jpeg_for_camera(camera_id: str | None, *, annotated: bool) -> bytes | None:
    """Return this camera's frame. A named camera never borrows another camera's JPEG."""
    requested = (camera_id or "").strip()
    _cam, publish = _get_stream_publish(camera_id)
    if publish is not None:
        if annotated and publish.annotated_jpeg:
            return publish.annotated_jpeg
        if publish.last_jpeg:
            return publish.last_jpeg
        if publish.annotated_jpeg:
            return publish.annotated_jpeg
        if requested:
            return None
    elif requested:
        return None
    with _lock:
        return _state.get("last_jpeg")


@app.get("/frame.jpeg")
def frame_jpeg(camera_id: str | None = None):
    data = _jpeg_for_camera(camera_id, annotated=False)
    if not data:
        return Response(status_code=503)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store, no-cache"},
    )


@app.get("/annotated.jpeg")
def annotated_jpeg(camera_id: str | None = None):
    """Inference-frame JPEG with boxes burned in (frame-accurate sync)."""
    data = _jpeg_for_camera(camera_id, annotated=True)
    if not data:
        return Response(status_code=503)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store, no-cache"},
    )


def _mjpeg_bytes(camera_id: str | None = None, *, annotated: bool = False):
    while not _stop.is_set():
        data = _jpeg_for_camera(camera_id, annotated=annotated)
        if data:
            yield (
                b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                + str(len(data)).encode("ascii")
                + b"\r\n\r\n"
                + data
                + b"\r\n"
            )
        time.sleep(0.08)


@app.get("/stream.mjpeg")
def stream_mjpeg(camera_id: str | None = None):
    return StreamingResponse(
        _mjpeg_bytes(camera_id, annotated=False),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store, no-cache"},
    )


@app.get("/annotated.mjpeg")
def annotated_mjpeg(camera_id: str | None = None):
    """Live annotated view: boxes drawn on the exact YOLO frame per stream."""
    return StreamingResponse(
        _mjpeg_bytes(camera_id, annotated=True),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store, no-cache"},
    )


@app.get("/debug")
def debug(camera_id: str | None = None):
    cam, publish = _get_stream_publish(camera_id)
    if publish is not None:
        motion = publish.motion or {}
        boxes = publish.last_boxes or []
        raw = publish.raw_boxes or []
        filtered = publish.filtered_boxes or []
        tracks = publish.track_trace or []
        frame_id = publish.frame_id
        frame_captured_at = publish.frame_captured_at
        frame_source = publish.frame_source
        frame_w = publish.frame_w
        frame_h = publish.frame_h
        error = publish.last_error
    else:
        motion = _state.get("motion") or {}
        boxes = _state.get("last_boxes") or []
        raw = _state.get("raw_boxes") or []
        filtered = _state.get("filtered_boxes") or []
        tracks = _state.get("track_trace") or []
        frame_id = _state.get("frame_id")
        frame_captured_at = _state.get("frame_captured_at")
        frame_source = _state.get("frame_source") or "none"
        frame_w = _state.get("frame_w")
        frame_h = _state.get("frame_h")
        error = _state.get("last_error")
    return {
        "camera_id": cam,
        "conf": settings.conf,
        "record_conf": settings.record_conf,
        "iou": settings.iou,
        "min_confirmation_frames": settings.min_confirmation_frames,
        "detection_cooldown_seconds": settings.detection_cooldown_seconds,
        "tracker": "bytetrack",
        "detection_mode": detection_mode(),
        "interval_s": settings.interval_s,
        "motion_min_area": settings.motion_min_area,
        "motion_debug": settings.motion_debug,
        "frame_id": frame_id,
        "frame_captured_at": frame_captured_at,
        "frame_source": frame_source,
        "frame_width": frame_w,
        "frame_height": frame_h,
        "raw_boxes": raw,
        "filtered_boxes": filtered,
        "stable_boxes": boxes,
        "tracks": tracks,
        "motion": motion,
        "yolo_detected_waste": len(raw) > 0,
        "bytetrack_ids": [
            box.get("track_id")
            for box in boxes
            if box.get("track_id") is not None
        ],
        "error": error,
        "streams": list(_stream_states.keys()),
    }


@app.get("/datasets")
def datasets():
    catalog, _classes = load_dataset_catalog()
    return {"count": len(catalog), "catalog": catalog}


@app.get("/frame.jpeg")
def frame_jpeg():
    with _lock:
        data = _state.get("last_jpeg")
    if not data:
        return Response(status_code=503)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store, no-cache"},
    )


def _mjpeg_bytes():
    while not _stop.is_set():
        with _lock:
            data = _state.get("last_jpeg")
        if data:
            yield (
                b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                + str(len(data)).encode("ascii")
                + b"\r\n\r\n"
                + data
                + b"\r\n"
            )
        time.sleep(0.12)


@app.get("/stream.mjpeg")
def stream_mjpeg():
    return StreamingResponse(
        _mjpeg_bytes(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store, no-cache"},
    )


@app.get("/overlay")
def overlay(camera_id: str | None = None):
    """Boxes for one camera only. Missing stream → empty boxes (fail-closed)."""
    cam, publish = _get_stream_publish(camera_id)
    model_label = _state.get("model_label") or "YOLO"
    if publish is not None:
        return publish.overlay_payload(cam, model_label)
    return {
        "camera_id": cam,
        "boxes": [],
        "inference_ms": None,
        "model": model_label,
        "error": "stream not ready",
        "frame_id": None,
        "frame_captured_at": None,
        "connected": False,
        "motion": {},
        "motion_active": False,
        "hud_conf": float(settings.conf),
    }


if __name__ == "__main__":
    import socket
    import uvicorn

    # Fail fast with a clear message if another detector still holds the port.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        in_use = sock.connect_ex((settings.host, int(settings.port))) == 0
    if in_use:
        raise SystemExit(
            f"[detector] port {settings.host}:{settings.port} is already in use. "
            "Stop the other detector (taskkill the old python/app.py) then retry."
        )

    print(f"[detector] http://{settings.host}:{settings.port}")
    uvicorn.run(
        "app:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )
