"""
Coastal waste detector — YOLOv8-World (open-vocab / text embeddings).

Pulls frames from go2rtc, runs YOLO-World with waste class prompts,
posts live boxes + log hits to the Laravel API.
"""

from __future__ import annotations

import base64
import os
import re
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
from fastapi import FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
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
    # Used when api_base (the detector's own Laravel server, :8001) is down.
    api_fallback_base: str = "http://127.0.0.1:8000/api"
    detector_key: str = "tidalwatch-detector-local"
    interval_s: float = 0.5
    # How often each camera looks for objects outside the 14 CCTV classes.
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
    # Keep a recorded track after it drops out, so a new ID is not saved again.
    track_lost_timeout_seconds: float = 12.0
    log_cooldown_s: float = 10.0
    # Processed frames a saved object must stay missing before an inferred removal.
    absence_frames: int = 10
    # Mark "No Longer Visible" once waste has been missing this long (and for at
    # least ABSENCE_MIN_FRAMES processed frames). 0 = use ABSENCE_FRAMES only.
    absence_seconds: float = 4.0
    absence_min_frames: int = 2
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
    # Comma-separated class names the live detector never draws, records, or
    # sends to Detection Reviews (e.g. "Cardboard,Paper Drink Carton,Paper Bag").
    excluded_classes: str = ""


# Official class names. The live order comes from best.onnx itself
# (weights (5).pt has 13 classes: no Plastic Spoon).
# Fallback order from weights (11).pt.
# Plastic Bag is not in this model. Do not insert it or later labels shift.
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
    "Plastic Spoon",
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
    "plastic spoon": "alert",
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
    "plastic spoon": "Plastic Spoon",
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
    """Map a model/raw label onto the 14 CCTV class names."""
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


def register_model_classes(classes: list[str]) -> list[str]:
    """Add class names this model has that the detector did not know yet."""
    added: list[str] = []
    for name in classes:
        clean = str(name or "").strip()
        if not clean or canonical_waste_class(clean):
            continue
        ONNX_CLASSES.append(clean)
        _CLASS_BY_NORM[_norm_class(clean)] = clean
        added.append(clean)
    if added:
        print(f"[detector] new classes from the model: {added}")
    return added


def resolve_model_classes(model) -> list[str]:
    """Prefer ONNX model.names, rewritten to official dataset labels."""
    names = getattr(model, "names", None) or {}
    if isinstance(names, dict):
        ordered = [str(names[i]) for i in range(len(names))]
    else:
        ordered = [str(item) for item in list(names)]
    mapped = [canonical_waste_class(item) or item for item in ordered]
    if len(ordered) != len(ONNX_CLASSES):
        print(
            f"[detector] WARNING: ONNX class count {len(ordered)} != "
            f"{len(ONNX_CLASSES)} official names. Using the model's own order. "
            f"raw={ordered}"
        )
        return mapped
    mismatched = [
        (index, raw, official)
        for index, (raw, official) in enumerate(zip(mapped, ONNX_CLASSES))
        if raw != official
    ]
    if mismatched:
        print(f"[detector] WARNING: ONNX class names differ from ONNX_CLASSES: {mismatched}")
    return mapped


def onnx_model_family(path: Path) -> str:
    """Model size from the ONNX metadata, e.g. "YOLO11l". Falls back to "YOLO11"."""
    try:
        import onnxruntime as ort

        meta = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]).get_modelmeta()
        text = str(meta.custom_metadata_map.get("description") or "")
        match = re.search(r"YOLO\s*v?(\d+)([nsmlx])", text, re.IGNORECASE)
        if match:
            return f"YOLO{match.group(1)}{match.group(2).lower()}"
    except Exception:  # noqa: BLE001
        pass
    return "YOLO11"


def onnx_runtime_providers() -> list[str]:
    """Providers actually installed. CUDA is used only if this list includes it."""
    try:
        import onnxruntime as ort

        return list(ort.get_available_providers())
    except Exception:  # noqa: BLE001
        return []


def excluded_class_set() -> set[str]:
    """Official names of the classes switched off by EXCLUDED_CLASSES."""
    out: set[str] = set()
    for item in str(settings.excluded_classes or "").split(","):
        name = item.strip()
        if name:
            out.add(canonical_waste_class(name) or name)
    return out


def is_excluded_class(label: str | None) -> bool:
    if not label:
        return False
    return (canonical_waste_class(label) or label) in excluded_class_set()


def allowed_class_ids(class_names: list[str]) -> list[int] | None:
    """Model class ids to run NMS on, or None when nothing is excluded."""
    excluded = excluded_class_set()
    if not excluded:
        return None
    return [
        index
        for index, name in enumerate(class_names)
        if (canonical_waste_class(name) or name) not in excluded
    ]


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
# CAM-01/CAM-02 from DETECTOR_STREAMS. Dashboard cameras never replace these.
_env_stream_ids: set[str] = set()
MANAGED_CAMERAS_POLL_S = 15.0
_rtsp_cap: cv2.VideoCapture | None = None
TRAINED_WEIGHTS = Path(__file__).with_name("weights") / "trained" / "best.pt"
ONNX_WEIGHTS = Path(__file__).with_name("weights") / "trained" / "best.onnx"
# The live station uses the wide lenses only. Zoom streams are not paired.
_LENS_WIDE_OF: dict[str, str] = {}
_model_box: dict[str, Any] = {"model": None, "label": ""}
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
# Telephoto and zoomed frames make a real item fill much of the picture.
_CLOSEUP_CLASSES = {
    "Can",
    "Cardboard",
    "Ecobag",
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
}


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
        # Zoomed-in waste fills the frame. Size limits stay for labels that
        # are often a person; known close-up classes are kept.
        label = canonical_waste_class(str(b.get("class") or ""))
        if label not in _CLOSEUP_CLASSES and (w > max_w or h > max_h):
            continue
        if (
            label not in _CLOSEUP_CLASSES
            and (w / 100.0) * (h / 100.0) > 0.18
            and raw not in _MAX_BOX_PCT
        ):
            continue
        kept.append(b)
    return kept


def load_dataset_catalog() -> tuple[list[dict[str, Any]], list[str]]:
    """Only the 14-class local-merged dataset."""
    row = {
        "name": "local-merged",
        "model_id": "local-1/1",
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


def live_model():
    """The ONNX model the cameras are using. Deploy can replace it without a restart."""
    return _model_box.get("model")


def set_live_model(model, label: str) -> None:
    _model_box["model"] = model
    _model_box["label"] = label
    _state["model_label"] = label


def wait_for_paired_wide(camera_id: str) -> None:
    """Hold the zoom lens until the wide lens of the same camera has just published.

    The two lenses are one Tapo camera. Running the zoom immediately after the
    wide keeps both views on the same moment.
    """
    wide_id = _LENS_WIDE_OF.get(str(camera_id or "").upper())
    if not wide_id:
        return
    started = time.time()
    deadline = started + 3.0
    while time.time() < deadline and not _stop.is_set():
        wide = _stream_states.get(wide_id)
        published = getattr(wide, "overlay_published_at", None) if wide else None
        if published and float(published) >= started - 0.05:
            return
        _stop.wait(0.05)


def stream_detection_mode(go2rtc_src: str) -> str:
    """Both wide cameras use the full frame and closer crops. Telephoto stays one frame.

    Paco's bottles disappear when the whole 2304px frame is squeezed into 640,
    and a 2x2 grid can cut the same object in half. The wide pass keeps the
    full frame, the quadrants, and the left and right halves. stream6
    telephoto stays a single frame so one close object is not split.
    """
    src = str(go2rtc_src or "").strip().lower()
    # cam04 is the unused telephoto. cam01 and cam02 are the two wide lenses.
    if src == "cam04":
        return "full_frame"
    return "full_plus_tiles"


def _vertical_strips(width: int, height: int) -> list[tuple[int, int, int, int]]:
    """Left and right halves. A 2x2 grid cuts objects that sit on the middle line."""
    if width < 960:
        return []
    mid = width // 2
    overlap = int(width * 0.08)
    return [
        (0, 0, min(width, mid + overlap), height),
        (max(0, mid - overlap), 0, width, height),
    ]


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
    strips = _vertical_strips(width, height)
    if resolved == "tiles_2x2":
        return [*tiles, *strips]
    if len(tiles) > 1:
        return [(0, 0, width, height), *tiles, *strips]
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


def _box_center(box: dict[str, Any]) -> tuple[float, float] | None:
    width = float(box.get("width") or 0)
    height = float(box.get("height") or 0)
    if width <= 0 or height <= 0:
        return None
    return (
        float(box.get("left") or 0) + width / 2.0,
        float(box.get("top") or 0) + height / 2.0,
    )


_CLASS_FAMILY = {
    "Plastic Wrapper": "film",
    "Plastic Cellophane": "film",
    "Ecobag": "film",
    "Paper Bag": "film",
    "Plastic Bottle": "bottle",
    "Glass Bottle": "bottle",
    "Paper Drink Carton": "bottle",
    "Plastic Cup": "cup",
    "Styro Cup": "cup",
    "Styrofoam": "foam",
    "Cardboard": "sheet",
}


def _class_family(label: str | None) -> str:
    name = canonical_waste_class(str(label or "")) or str(label or "")
    return _CLASS_FAMILY.get(name, name.lower())


def same_physical_object(
    a: dict[str, Any] | None,
    b: dict[str, Any] | None,
    class_a: str | None = None,
    class_b: str | None = None,
) -> bool:
    """True when two boxes are the same piece of waste, even if the ID changed."""
    if not a or not b:
        return False
    iou = _iou(a, b)
    if iou >= 0.28:
        return True
    family_a = _class_family(class_a or a.get("class"))
    family_b = _class_family(class_b or b.get("class"))
    related = bool(family_a) and family_a == family_b
    if related and iou >= 0.14:
        return True
    center_a = _box_center(a)
    center_b = _box_center(b)
    if not center_a or not center_b:
        return False
    dist = ((center_a[0] - center_b[0]) ** 2 + (center_a[1] - center_b[1]) ** 2) ** 0.5
    if related and dist <= 12.0 and iou >= 0.06:
        return True
    if dist <= 8.0 and iou >= 0.10:
        return True
    return False


def recorded_track_for(
    tracks: dict[int, dict[str, Any]],
    box: dict[str, Any],
    track_id: int | None,
    pending_ids: set[int] | None = None,
) -> dict[str, Any] | None:
    """Return an already-saved track that covers this box."""
    pending = pending_ids or set()
    for old_id, state in tracks.items():
        if old_id == track_id:
            continue
        if not (
            state.get("recorded")
            or state.get("saved_id")
            or state.get("snapshot_saved")
            or old_id in pending
        ):
            continue
        last = state.get("last_box")
        if not isinstance(last, dict):
            continue
        if same_physical_object(box, last, box.get("class"), state.get("class")):
            return state
    return None


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
    "Plastic Wrapper": 0.80,
    "Plastic Cellophane": 0.80,
    "Styro Cup": 0.80,
    "Face Mask": 0.80,
    "Ecobag": 0.84,
    "Paper Drink Carton": 0.84,
    "Styrofoam": 0.84,
    "Cardboard": 0.82,
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
    if label in _CLOSEUP_CLASSES:
        # A zoomed bottle or bag can fill half the frame. Only a standing
        # person shape is rejected.
        return height >= 72 and width >= 20 and aspect >= 1.6
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

    # A person or piece of clothing can fill the frame as film.
    # A zoomed wrapper is large too, so only a tall blob is dropped.
    if area > 0.35 and aspect >= 1.3 and label in _GENERIC_FILM:
        return None

    # Weak wrapper scores are the usual bottle/can mix-up. Keep only strong film.
    if label in _GENERIC_FILM:
        if conf < _CLASS_MIN_CONF.get(label, 0.82):
            return None
        return label

    # Needle-thin bags are almost always a person, pole, or bottle.
    if label in _BAG_WASTE and aspect >= 2.6 and width <= 10.0:
        return None

    # The live box uses the model's class. Shape guesses stay behind the flag.
    if not _identity_remap_enabled():
        return label

    # Snack packs are often called Ecobag. A real eco bag fills more of the frame.
    if label == "Ecobag" and area < 0.035 and width < 16.0 and height < 22.0:
        return "Plastic Wrapper"

    # A round bottle is not a juice carton.
    if label == "Paper Drink Carton" and aspect >= 2.45 and width <= 7.5:
        return "Plastic Bottle"

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
    """Drop unreliable boxes. Overlaps keep the higher-confidence class.

    A known class that is too weak to save is returned in review_out so it can
    be checked in Detection Reviews.
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
        if is_excluded_class(str(box.get("class") or "")):
            continue
        label = refine_waste_class(box)
        if label and is_excluded_class(label):
            continue
        if not label:
            score = float(box.get("confidence") or 0)
            official = canonical_waste_class(str(box.get("class") or ""))
            if official and DRAW_FLOOR <= score < MIN_DETECT_CONF:
                box["class"] = official
                box["raw_class"] = official.lower()
                box["provisional"] = True
                if review_out is not None and score >= REVIEW_POSSIBLE_FLOOR:
                    review_out.append(dict(box))
                log_rejected(
                    str(box.get("camera_id") or "-"),
                    official,
                    score,
                    "below_80",
                )
                refined.append(box)
                continue
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
        box_conf = float(box.get("confidence") or 0)
        overlapped = False
        for prev in kept:
            if _iou(box, prev) < 0.35 and not _same_object(box, prev, 0.35):
                continue
            # The stronger score is the class written on the box.
            if box_conf > float(prev.get("confidence") or 0) + 0.05:
                kept[kept.index(prev)] = box
            overlapped = True
            break
        if not overlapped:
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
    keep_ids = allowed_class_ids(class_names)
    t_predict = time.perf_counter()
    for x0, y0, x1, y1 in regions:
        crop = frame[y0:y1, x0:x1]
        t_crop = time.perf_counter()
        results = model.predict(
            crop,
            conf=conf_min,
            iou=iou,
            imgsz=int(settings.imgsz) if int(settings.imgsz) > 0 else 640,
            agnostic_nms=True,
            max_det=50,
            classes=keep_ids,
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
            if not label or is_excluded_class(label):
                continue
            raw = label.lower()
            boxes.append(
                {
                    "id": f"yolo-{cls_id}-{int(gx1)}-{int(gy1)}",
                    "class": label,
                    "cls_id": cls_id,
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
        stored = box.get("cls_id")
        if box["class"] in class_names:
            clss.append(class_names.index(box["class"]))
        elif isinstance(stored, int) and 0 <= stored < len(class_names):
            clss.append(stored)
        else:
            clss.append(0)
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


_API_BASE_CHOICE = {"base": "", "checked": 0.0}
_API_BASE_LOCK = Lock()


def api_base() -> str:
    """
    Laravel address for detector posts. Prefer API_BASE (the detector's own
    server); if it does not answer, use API_FALLBACK_BASE so detections,
    presence and Today's Report keep updating. Re-checked every 20 seconds.
    """
    primary = settings.api_base.rstrip("/")
    fallback = (settings.api_fallback_base or "").rstrip("/")
    if not fallback or fallback == primary:
        return primary
    now = time.time()
    with _API_BASE_LOCK:
        if _API_BASE_CHOICE["base"] and now - _API_BASE_CHOICE["checked"] < 20:
            return _API_BASE_CHOICE["base"]
        _API_BASE_CHOICE["checked"] = now
    chosen = primary
    try:
        # Any HTTP answer (even 401) means the server is up.
        httpx.get(f"{primary}/settings/detection", timeout=1.0)
    except Exception:
        chosen = fallback
    with _API_BASE_LOCK:
        if chosen != _API_BASE_CHOICE["base"]:
            print(f"[detector] Laravel API: {chosen}" + (" (fallback; API_BASE is not answering)" if chosen == fallback else ""))
        _API_BASE_CHOICE["base"] = chosen
    return chosen


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


# Waste Detections saves only sure detections; lower scores go to Detection Reviews only.
WASTE_DETECTION_MIN_CONF = 0.80


def crop_confirmed_jpeg(frame, box, pad_ratio: float = 0.15) -> str | None:
    """Zoomed snapshot for Waste Detections: one confirmed box from this frame."""
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
    crop_h, crop_w = crop.shape[:2]
    longest = max(crop_h, crop_w)
    if longest > 480:
        scale = 480 / float(longest)
        crop = cv2.resize(
            crop,
            (max(1, int(crop_w * scale)), max(1, int(crop_h * scale))),
        )
    ok, buf = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
    if not ok:
        return None
    return base64.b64encode(buf.tobytes()).decode("ascii")


SNAPSHOT_MAX_SIDE = 1920
SNAPSHOT_JPEG_QUALITY = 85


def full_frame_jpeg(frame) -> str | None:
    """Detection Reviews snapshot: the whole livestream frame, no crop or zoom.

    Training images then look like what the cameras see, and the saved box
    (percent of the full frame) lines up with the image in Detection Reviews.
    """
    if frame is None:
        return None
    frame_h, frame_w = frame.shape[:2]
    if frame_w < 1 or frame_h < 1:
        return None
    image = frame
    longest = max(frame_h, frame_w)
    if longest > SNAPSHOT_MAX_SIDE:
        scale = SNAPSHOT_MAX_SIDE / float(longest)
        image = cv2.resize(
            frame,
            (max(1, int(frame_w * scale)), max(1, int(frame_h * scale))),
            interpolation=cv2.INTER_AREA,
        )
    ok, buf = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), SNAPSHOT_JPEG_QUALITY])
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
    """Confirm a box when it is solid enough to save, without waiting for three 80% looks.

    A broad class is ready on one score at or above record_conf. A specific
    class is ready once it repeats at STEADY_RECORD_CONF. The stored score is
    the highest look so far. recorded is stored on the track id.
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
        model_class = str(box["class"])
        votes.append(model_class)
        # Best score per class: a label is only ever shown with its own score.
        class_best = dict(state.get("class_best") or {}) if state else {}
        class_best[model_class] = max(float(class_best.get(model_class) or 0), score)
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
        elif state["class"] != model_class:
            # One noisy frame must not rename the object, but a sure or repeated
            # new class must win quickly (each frame takes a few seconds here).
            held_best = float(class_best.get(state["class"]) or 0)
            recent = list(votes)[-2:]
            repeated = len(recent) == 2 and all(name == model_class for name in recent)
            sure = score >= record_conf and score > held_best
            if repeated or sure:
                state["class"] = model_class
                state["frames"] = 0
                state["display_hits"] = 0
                state["qual_scores"] = []
            else:
                box["class"] = state["class"]
                box["raw_class"] = str(state["class"]).lower()
                box["label_held"] = True
        state["class_votes"] = votes
        state["class_best"] = class_best
        state["last_seen"] = now
        state["last_confidence"] = score
        # The score shown and saved belongs to the label shown.
        state["best_conf"] = float(class_best.get(state["class"]) or 0)
        if box["class"] in _STEADY_CLASSES and score >= STEADY_RECORD_CONF:
            state["display_hits"] = int(state.get("display_hits") or 0) + 1
        prev_box = state.get("last_box")
        if isinstance(prev_box, dict):
            for key in ("left", "top", "width", "height"):
                if key not in box or key not in prev_box:
                    continue
                box[key] = round(0.72 * float(box[key]) + 0.28 * float(prev_box[key]), 2)
        state["last_box"] = _box_snapshot(box)
        state["frames"] = int(state.get("frames") or 0) + 1
        tracks[track_id] = state
        box["frames"] = state["frames"]
        peak = round(float(state["best_conf"]), 4)
        box["validation_confidence"] = peak
        # The label shows the highest score. Recording still uses this frame's score.
        box["confidence"] = peak
        # Only this frame's own class can confirm a save; a held label never
        # borrows the score of a different class.
        ready = score >= record_conf and not box.get("label_held")
        box["confirmed"] = bool(ready and not state.get("recorded"))
        queued = float(state.get("queued_confidence") or 0)
        box["confidence_upgrade"] = bool(state.get("recorded") and peak > queued + 0.005)
    for track_id in list(tracks):
        if track_id in seen:
            continue
        last_seen = float(tracks[track_id].get("last_seen") or 0)
        hold = timeout * 2.5 if tracks[track_id].get("recorded") else timeout
        if now - last_seen > hold:
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
    """One new database event per track, on the first solid look.

    cooldown_s and min_frames stay in the signature for the existing callers.
    The save uses the track's highest score, not a three-frame average.
    """
    del cooldown_s, min_frames, record_conf
    events: list[dict[str, Any]] = []
    for box in boxes:
        track_id = box.get("track_id")
        if track_id is None or not box.get("confirmed"):
            continue
        state = tracks.get(track_id)
        if state is None:
            continue
        if prevent_duplicate and (state.get("recorded") or state.get("snapshot_saved")):
            continue
        if prevent_duplicate:
            dup = recorded_track_for(tracks, box, track_id)
            if dup is not None:
                state["recorded"] = True
                state["snapshot_saved"] = bool(dup.get("snapshot_saved") or state.get("snapshot_saved"))
                if isinstance(dup.get("saved_id"), int):
                    state["saved_id"] = dup["saved_id"]
                box["confirmed"] = False
                continue
        events.append(box)
    return events


def retain_active_overlay_boxes(
    boxes: list[dict[str, Any]],
    tracks: dict[int, dict[str, Any]],
    now: float,
    lost_timeout_s: float,
) -> list[dict[str, Any]]:
    """Keep a box on screen while ByteTrack still owns the object.

    Recording a detection does not remove it. A frame with no new box holds
    the last position until the track expires. A box already in this frame
    stays as it is.
    """
    present = {
        box.get("track_id")
        for box in boxes
        if box.get("track_id") is not None
    }
    held = list(boxes)
    timeout = max(0.0, float(lost_timeout_s))
    for track_id, state in tracks.items():
        if track_id in present:
            continue
        last_seen = float(state.get("last_seen") or 0)
        if now - last_seen > timeout:
            continue
        last = state.get("last_box")
        if not isinstance(last, dict):
            continue
        box = dict(last)
        box["track_id"] = track_id
        box["held"] = True
        box["provisional"] = False
        box["class"] = state.get("class") or box.get("class")
        box["confidence"] = state.get("best_conf", state.get("last_confidence", box.get("confidence")))
        box["frames"] = state.get("frames")
        box["confirmed"] = bool(state.get("recorded"))
        held.append(box)
    return held


# After a solid look, keep following the object down to this score.
# Weaker hits stay off the screen so a cat is not boxed as foam.
DISPLAY_CONF = 0.45
# Draw a known class this weak. Saving still waits for the 80% line.
DRAW_FLOOR = 0.40
OVERLAY_HOLD_S = 16.0
# A specific class is saved once it repeats at this score. A broad class
# still needs one look at record_conf. Anything weaker can be a review.
STEADY_RECORD_CONF = 0.62
REVIEW_POSSIBLE_FLOOR = 0.50
# These classes are specific enough to draw before the 80% save line,
# once the same track repeats. Broad classes wait for 80%.
_STEADY_CLASSES = {
    "Can",
    "Glass Bottle",
    "Paper Drink Carton",
    "Plastic Bottle",
    "Plastic Cup",
    "Plastic Spoon",
    "Styro Cup",
}


def overlay_hold_seconds(configured: float) -> float:
    """Keep the box through a few missed looks. Three seconds was too short."""
    return max(OVERLAY_HOLD_S, float(configured))


def adopt_existing_tracks(
    boxes: list[dict[str, Any]],
    tracks: dict[int, dict[str, Any]],
    now: float,
    lost_timeout_s: float,
) -> None:
    """Reuse the current track when ByteTrack assigns a new id to the same object."""
    claimed = {
        box.get("track_id")
        for box in boxes
        if box.get("track_id") in tracks
    }
    for box in boxes:
        track_id = box.get("track_id")
        if track_id in tracks:
            continue
        best_id = None
        best_score = 0.0
        for old_id, state in tracks.items():
            if old_id in claimed:
                continue
            last = state.get("last_box")
            if not isinstance(last, dict):
                continue
            recorded = bool(
                state.get("recorded") or state.get("saved_id") or state.get("snapshot_saved")
            )
            hold = lost_timeout_s * 2.5 if recorded else lost_timeout_s
            if now - float(state.get("last_seen") or 0) > hold:
                continue
            iou = _iou(box, last)
            if not same_physical_object(box, last, box.get("class"), state.get("class")) and iou < 0.18:
                continue
            score = iou
            if str(box.get("class") or "") == str(state.get("class") or ""):
                score += 0.08
            elif _class_family(box.get("class")) == _class_family(state.get("class")):
                score += 0.04
            if recorded:
                score += 0.06
            if score > best_score:
                best_score = score
                best_id = old_id
        if best_id is None:
            continue
        box["track_id"] = best_id
        box["id"] = f"track-{best_id}"
        claimed.add(best_id)


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
        if not label or is_excluded_class(label):
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
        "enabled": False,
        "confidence": float(settings.conf),
        "interval": 1,
        "classes": set(ONNX_CLASSES),
        "record_conf": float(settings.record_conf),
        "min_frames": int(settings.min_confirmation_frames),
        "track_lost_timeout": float(settings.track_lost_timeout_seconds),
        "prevent_duplicate": True,
        "save_snapshots": True,
        "review_conf": 0.60,
    }


_DETECTION_SETTINGS_LOCK = Lock()
_DETECTION_SETTINGS_CACHE: dict[str, Any] | None = None
_DETECTION_SETTINGS_AT = 0.0
_DETECTION_ENABLED_OVERRIDE: bool | None = None
_DETECTION_ENABLED_OVERRIDE_UNTIL = 0.0


def _effective_enabled(api_enabled: bool) -> bool:
    global _DETECTION_ENABLED_OVERRIDE
    if _DETECTION_ENABLED_OVERRIDE is None:
        return api_enabled
    if time.time() > _DETECTION_ENABLED_OVERRIDE_UNTIL:
        _DETECTION_ENABLED_OVERRIDE = None
        return api_enabled
    if api_enabled == _DETECTION_ENABLED_OVERRIDE:
        _DETECTION_ENABLED_OVERRIDE = None
        return api_enabled
    return _DETECTION_ENABLED_OVERRIDE


def _blank_all_overlays() -> None:
    with _lock:
        states = list(_stream_states.values())
    now = time.time()
    for publish in states:
        publish.last_boxes = []
        publish.raw_boxes = []
        publish.filtered_boxes = []
        publish.annotated_jpeg = None
        publish.overlay_published_at = now


def apply_detection_enabled(enabled: bool) -> bool:
    global _DETECTION_ENABLED_OVERRIDE, _DETECTION_ENABLED_OVERRIDE_UNTIL
    global _DETECTION_SETTINGS_CACHE, _DETECTION_SETTINGS_AT
    flag = bool(enabled)
    _DETECTION_ENABLED_OVERRIDE = flag
    _DETECTION_ENABLED_OVERRIDE_UNTIL = time.time() + 45.0
    with _DETECTION_SETTINGS_LOCK:
        current = dict(_DETECTION_SETTINGS_CACHE or _fallback_detection_settings())
        current["enabled"] = flag
        _DETECTION_SETTINGS_CACHE = current
        # The stream loop reads this cache on its next tick. Stamp the time
        # so that tick does not wait for a settings request that often times out.
        _DETECTION_SETTINGS_AT = time.time()
    if not flag:
        _blank_all_overlays()
    return flag


SETTINGS_POLL_S = 3.0


def _refresh_detection_settings(
    client: httpx.Client,
    current: dict[str, Any],
    fetched_at: float,
) -> tuple[dict[str, Any], float]:
    """Pull the Detection tab. Keep the last good values if Laravel is down."""
    global _DETECTION_SETTINGS_CACHE, _DETECTION_SETTINGS_AT
    now = time.time()
    with _DETECTION_SETTINGS_LOCK:
        # On/Off already arrives instantly through POST /runtime/detection, so
        # Laravel is only re-read every few seconds. Laravel serves one request
        # at a time on Windows; frequent polling here slows every dashboard page.
        if _DETECTION_SETTINGS_AT and now - _DETECTION_SETTINGS_AT < SETTINGS_POLL_S:
            return (_DETECTION_SETTINGS_CACHE or current), _DETECTION_SETTINGS_AT
        if now - fetched_at < SETTINGS_POLL_S:
            return current, fetched_at
        # Claim the slot so the other three streams do not stampede Laravel.
        _DETECTION_SETTINGS_AT = now
    try:
        response = client.get(
            f"{api_base()}/settings/detection",
            headers={"X-Detector-Key": settings.detector_key},
            timeout=1.5,
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
            "enabled": _effective_enabled(bool(body.get("enabled", False))),
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
                max(MIN_PROPOSAL_CONF, float(body.get("review_confidence", 0.60))),
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
    """Only the 14 CCTV classes can be drawn or recorded."""
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
    review_floor = float(live.get("review_conf", 0.60))
    return min(live_floor - 0.01, max(MIN_PROPOSAL_CONF, review_floor))


def _low_confidence_review_boxes(
    boxes: list[dict[str, Any]],
    live: dict[str, Any],
) -> list[dict[str, Any]]:
    """Low-confidence classes are not queued. An admin moves them from Detections."""
    del boxes, live
    return []


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


_camera_ingest_blocked_until: dict[str, float] = {}


def camera_ingest_allowed(camera_id: str, now: float | None = None) -> bool:
    until = _camera_ingest_blocked_until.get(str(camera_id), 0.0)
    return (time.time() if now is None else now) >= until


def block_camera_ingest(camera_id: str, seconds: float = 300.0, now: float | None = None) -> None:
    """Stop posting records for a camera Laravel does not have."""
    _camera_ingest_blocked_until[str(camera_id)] = (
        time.time() if now is None else now
    ) + max(1.0, float(seconds))


def ingest_looks_like_missing_camera(status_code: int | None, text: str) -> bool:
    if int(status_code or 0) != 422:
        return False
    return "camera not found" in str(text or "").lower()


def _detections_payload(pending: dict[int, dict[str, Any]], track_ids: list[int], *, include_snapshot: bool) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for track_id in track_ids:
        row = dict(pending.get(track_id) or {})
        if not include_snapshot:
            row.pop("snapshot", None)
        rows.append(row)
    return rows


def _post_json_job(job: dict[str, Any], url: str, payload: dict[str, Any], headers: dict[str, str]) -> None:
    """POST without holding the camera loop. A slow save must not hide boxes."""
    try:
        response = httpx.post(url, json=payload, headers=headers, timeout=120.0)
        job["status"] = response.status_code
        job["text"] = response.text[:400]
        if response.status_code in (200, 201):
            job["body"] = response.json()
    except Exception as exc:  # noqa: BLE001
        job["error"] = exc
    finally:
        job["done"] = True


def _start_json_job(url: str, payload: dict[str, Any], headers: dict[str, str], **extra: Any) -> dict[str, Any]:
    job: dict[str, Any] = {"done": False, "error": None, "body": None, "status": None, "text": ""}
    job.update(extra)
    Thread(
        target=_post_json_job,
        args=(job, url, payload, headers),
        daemon=True,
    ).start()
    return job


def _saved_ids_from_body(
    body: dict[str, Any] | None,
    key: str = "detections",
    any_id: bool = False,
) -> dict[int, int | None]:
    saved: dict[int, int | None] = {}
    for item in (body or {}).get(key) or []:
        subtitle = str(item.get("subtitle") or "")
        if "Track " not in subtitle:
            continue
        try:
            track_match = int(subtitle.split("Track ", 1)[1].split(" ", 1)[0])
        except ValueError:
            continue
        detection_id = item.get("id")
        if isinstance(detection_id, int) or any_id:
            saved[track_match] = detection_id if isinstance(detection_id, int) else None
    return saved


def stream_worker_loop(cfg: StreamConfig, model, model_label: str, stop_event: Event | None = None) -> None:
    """Independent detection loop for one camera/lens stream."""
    # Cameras added from the dashboard get their own stop switch, so one can be
    # stopped without touching the others. CAM-01/CAM-02 keep the global one.
    stop = stop_event or _stop
    camera_id = cfg.stream_key
    publish = StreamPublishState(ready=True)
    reader = LatestFrameReader(
        name=camera_id,
        stop_event=stop,
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
    presence_book = PresenceBook(
        settings.absence_frames,
        absence_seconds=(float(settings.absence_seconds) if float(settings.absence_seconds) > 0 else None),
        min_absent_frames=settings.absence_min_frames,
    )
    motion_box_fraction = max(0.0, float(settings.motion_box_fraction))
    last_unfamiliar_at = time.time()
    last_presence_at = 0.0
    print(f"[detector] stream {camera_id} · src={cfg.go2rtc_src} · session {tracker_session}")
    _publish_stream(camera_id, publish)

    # Saves use their own 120s request off this loop. This client must stay
    # short so a busy API cannot freeze the overlay.
    save_job: dict[str, Any] | None = None
    status_job: dict[str, Any] | None = None
    save_retry_at = 0.0
    with httpx.Client(timeout=8.0) as client:
        while not stop.is_set():
            if save_job is not None and save_job.get("done"):
                sending_ids = list(save_job.get("ids") or [])
                error = save_job.get("error")
                status_code = save_job.get("status")
                if error is not None or status_code not in (200, 201):
                    save_retry_at = time.time() + 3.0
                    fail_text = str(error or save_job.get("text") or status_code)
                    print(f"[detector] {camera_id} save failed: {fail_text}")
                    if ingest_looks_like_missing_camera(status_code, fail_text):
                        block_camera_ingest(camera_id, 300.0)
                        pending_saves.clear()
                        print(
                            f"[detector] {camera_id} ingest paused — camera is not in Laravel"
                        )
                else:
                    save_retry_at = 0.0
                    saved_ids = _saved_ids_from_body(save_job.get("body"))
                    reviewed = _saved_ids_from_body(save_job.get("body"), key="reviews", any_id=True)
                    for track_id in sending_ids:
                        # A review-only row is sent once even if the API skipped it
                        # (e.g. below the review floor), so it is not resent each frame.
                        if track_id not in reviewed and not (pending_saves.get(track_id) or {}).get("review_only"):
                            continue
                        state = tracks.get(track_id)
                        if state is not None:
                            state["review_sent"] = True
                        pending_saves.pop(track_id, None)
                    if reviewed:
                        print(
                            f"[detector] {camera_id} below 80%, Detection Reviews only: "
                            f"{sorted(reviewed)}"
                        )
                    recorded_now = []
                    for track_id in sending_ids:
                        state = tracks.get(track_id)
                        detection_id = saved_ids.get(track_id)
                        if detection_id is None or state is None:
                            continue
                        state["recorded"] = bool(live_detection["prevent_duplicate"])
                        state["snapshot_saved"] = bool(live_detection["save_snapshots"])
                        state["saved_id"] = detection_id
                        state["review_sent"] = True
                        state["debug_logged"] = True
                        pending_saves.pop(track_id, None)
                        recorded_now.append((track_id, detection_id))
                    if recorded_now:
                        print(f"[detector] {camera_id} saved {recorded_now}")
                    missing = [track_id for track_id in sending_ids if track_id in pending_saves]
                    if missing:
                        print(f"[detector] {camera_id} save missing id for tracks {missing}")
                save_job = None
            if status_job is not None and status_job.get("done"):
                error = status_job.get("error")
                status_code = status_job.get("status")
                if error is not None or status_code not in (200, 201):
                    for row in status_job.get("rows") or []:
                        watch = presence_book.watch.get(row.get("detection_id"))
                        if watch is not None and row.get("status") in ("No Longer Visible", "Confirmed Cleaned"):
                            watch["sent"] = False
                    print(
                        f"[detector] {camera_id} presence update failed: "
                        f"{error or status_job.get('text') or status_code}"
                    )
                else:
                    print(f"[detector] {camera_id} presence {status_job.get('rows')}")
                status_job = None
            t0 = time.perf_counter()
            live_detection, settings_fetched_at = _refresh_detection_settings(
                client,
                live_detection,
                settings_fetched_at,
            )
            if not live_detection.get("enabled", False):
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
                stop.wait(0.25)
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
                stop.wait(0.02)
                continue
            if frame_id == last_frame_id:
                stop.wait(0.02)
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
                stop.wait(0.01)
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
                wait_for_paired_wide(camera_id)
                raw_boxes = track_frame_boxes(
                    live_model() or model,
                    frame,
                    proposal,
                    settings.iou,
                    _model_classes,
                    tracker=tracker,
                    inference_lock=_inference_lock,
                    mode=stream_detection_mode(cfg.go2rtc_src),
                    review_out=review_out,
                )
                for box in raw_boxes:
                    box["camera_id"] = camera_id
                    box["stream_src"] = cfg.go2rtc_src
                    box["frame_id"] = frame_id
                overlay_boxes = filter_overlay_boxes(raw_boxes)
                now = time.time()
                record_conf = float(live_detection["record_conf"])
                hold_s = overlay_hold_seconds(float(live_detection["track_lost_timeout"]))
                adopt_existing_tracks(overlay_boxes, tracks, now, hold_s)
                # Follow a box that has already qualified so a dip under 80%
                # does not erase it. A new broad label still has to clear 80%.
                followed = []
                for box in overlay_boxes:
                    score = float(box.get("confidence") or 0)
                    track_id = box.get("track_id")
                    label = canonical_waste_class(str(box.get("class") or ""))
                    known = track_id is not None and track_id in tracks
                    if score >= record_conf or (known and score >= DISPLAY_CONF):
                        followed.append(box)
                    elif label in _STEADY_CLASSES and score >= 0.62:
                        followed.append(box)
                    elif box.get("provisional") and score >= DRAW_FLOOR:
                        followed.append(box)
                boxes = update_tracks(
                    tracks,
                    followed,
                    now,
                    int(live_detection["min_frames"]),
                    record_conf,
                    hold_s,
                )
                visible = []
                for box in boxes:
                    track_id = box.get("track_id")
                    state = tracks.get(track_id) if track_id is not None else None
                    score = float(box.get("confidence") or 0)
                    if state is not None and (
                        score >= record_conf
                        or int(state.get("display_hits") or 0) >= 2
                        or state.get("recorded")
                    ):
                        state["shown"] = True
                    if state is not None and state.get("shown") and score >= DISPLAY_CONF:
                        box["provisional"] = False
                        visible.append(box)
                    elif box.get("provisional") and score >= DRAW_FLOOR:
                        visible.append(box)
                    elif state is not None and score >= DRAW_FLOOR:
                        box["provisional"] = True
                        visible.append(box)
                annotate_detection_stages(visible, tracks)
                shown_tracks = {
                    tid: state
                    for tid, state in tracks.items()
                    if state.get("shown") or state.get("recorded")
                }
                hud_boxes_out = retain_active_overlay_boxes(
                    visible,
                    shown_tracks,
                    now,
                    hold_s,
                )
                annotate_detection_stages(hud_boxes_out, tracks)
                hud_boxes_out = [dict(box) for box in hud_boxes_out]
                for box in hud_boxes_out:
                    box["camera_id"] = camera_id
                    box["stream_src"] = cfg.go2rtc_src
                    box["frame_id"] = frame_id
                    box["provisional"] = False
                    track_id = box.get("track_id")
                    state = tracks.get(track_id) if track_id is not None else None
                    if state is not None and isinstance(state.get("saved_id"), int):
                        box["detection_id"] = int(state["saved_id"])
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
                        f"raw={len(raw_boxes)} kept={len(visible)} "
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
                snapshot_cache: list[str | None] = []

                def frame_snapshot() -> str | None:
                    # Encode this frame once, even when several waste items are saved from it.
                    if not snapshot_cache:
                        snapshot_cache.append(full_frame_jpeg(frame))
                    return snapshot_cache[0]

                # Detection Reviews: tracks that stay in the 60-79% band. They never
                # reach record_conf, so they are not save events; send each one once
                # (full frame) after it has been seen for MIN_CONFIRMATION_FRAMES.
                review_floor = _review_confidence_floor(live_detection)
                review_frames = max(1, int(live_detection["min_frames"]))
                for row in boxes:
                    track_id = row.get("track_id")
                    state = tracks.get(track_id) if track_id is not None else None
                    if state is None or track_id in pending_saves:
                        continue
                    if state.get("recorded") or state.get("review_sent"):
                        continue
                    if canonical_waste_class(str(row.get("class") or "")) not in ONNX_CLASSES:
                        continue
                    peak = float(row.get("validation_confidence", row.get("confidence") or 0))
                    if not (review_floor <= peak < WASTE_DETECTION_MIN_CONF):
                        continue
                    if int(state.get("frames") or 0) < review_frames:
                        continue
                    pending_saves[track_id] = {
                        "class": row["class"],
                        "confidence": peak,
                        "count": 1,
                        "severity": row.get("severity") or "alert",
                        "sector": cfg.sector,
                        "subtitle": f"Track {track_id} · YOLO · {camera_id} · {cfg.go2rtc_src}",
                        "frame_id": frame_id,
                        "left": row.get("left"),
                        "top": row.get("top"),
                        "width": row.get("width"),
                        "height": row.get("height"),
                        "review_only": True,
                        "snapshot": None,
                        "review_snapshot": frame_snapshot(),
                    }

                for row in events:
                    if canonical_waste_class(str(row.get("class") or "")) not in ONNX_CLASSES:
                        continue
                    track_id = row.get("track_id")
                    state = tracks.get(track_id) if track_id is not None else None
                    if track_id is None or state is None or track_id in pending_saves:
                        continue
                    if live_detection["prevent_duplicate"] and state.get("recorded"):
                        continue
                    peak = float(row.get("validation_confidence", row["confidence"]))
                    if peak < WASTE_DETECTION_MIN_CONF:
                        # Not sure enough for Waste Detections: send the full frame
                        # to Detection Reviews once, and keep watching this track.
                        # Only 60-79% is saved (Settings > Detection > Review confidence).
                        if state.get("review_sent") or peak < _review_confidence_floor(live_detection):
                            continue
                        pending_saves[track_id] = {
                            "class": row["class"],
                            "confidence": peak,
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
                            "review_only": True,
                            "snapshot": None,
                            "review_snapshot": frame_snapshot(),
                        }
                        continue
                    state["recorded"] = True
                    state["snapshot_saved"] = bool(live_detection["save_snapshots"])
                    state["debug_logged"] = True
                    save_class = row["class"]
                    state["queued_confidence"] = peak
                    pending_saves[track_id] = {
                        "class": save_class,
                        "confidence": peak,
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
                        # Zoomed snapshot for Waste Detections.
                        "snapshot": (
                            crop_confirmed_jpeg(frame, row)
                            if live_detection["save_snapshots"]
                            else None
                        ),
                        # Full livestream frame for Detection Reviews (once per track).
                        "review_snapshot": (
                            None  # 80%+ stays in Waste Detections only
                        ),
                    }
                inflight_ids = set((save_job or {}).get("ids") or [])
                for box in boxes:
                    if not box.get("confidence_upgrade"):
                        continue
                    track_id = box.get("track_id")
                    state = tracks.get(track_id) if track_id is not None else None
                    if track_id is None or state is None or track_id in inflight_ids:
                        continue
                    peak = float(box.get("validation_confidence") or state.get("best_conf") or 0)
                    if track_id in pending_saves:
                        if pending_saves[track_id].get("review_only"):
                            continue
                        pending_saves[track_id]["confidence"] = peak
                        state["queued_confidence"] = peak
                        continue
                    if not state.get("recorded"):
                        # The save loop above decides when a track enters Waste Detections.
                        continue
                    if live_detection["prevent_duplicate"] and (
                        state.get("recorded")
                        or recorded_track_for(tracks, box, track_id, set(pending_saves))
                    ):
                        continue
                    state["queued_confidence"] = peak
                    pending_saves[track_id] = {
                        "class": state.get("class") or box.get("class"),
                        "confidence": peak,
                        "count": 1,
                        "severity": box.get("severity") or "alert",
                        "sector": cfg.sector,
                        "subtitle": (
                            f"Track {track_id} · YOLO · {camera_id} · {cfg.go2rtc_src}"
                        ),
                        "frame_id": frame_id,
                        "left": box.get("left"),
                        "top": box.get("top"),
                        "width": box.get("width"),
                        "height": box.get("height"),
                        "histogram": hue_histogram(frame, box),
                        "snapshot": None,
                    }
                # Below 80%: Detection Reviews only (full frame). 80% and up: Waste
                # Detections (zoomed snapshot) plus one full frame in Detection Reviews.
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
                publish.filtered_boxes = visible
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

                live_track_ids = {
                    box.get("track_id")
                    for box in followed
                    if box.get("track_id") is not None
                }
                active_saved = {
                    tid: {
                        "detection_id": int(state["saved_id"]),
                        "box": state.get("last_box") or {},
                        "class": state.get("class"),
                    }
                    for tid, state in tracks.items()
                    if tid in live_track_ids and isinstance(state.get("saved_id"), int)
                }
                visible_detection_ids = [
                    int(state["saved_id"])
                    for tid, state in tracks.items()
                    if tid in live_track_ids and isinstance(state.get("saved_id"), int)
                ]
                status_updates = presence_book.step(
                    active_saved,
                    motion_mask,
                    stream_ok=reader.connected,
                    scene_boxes=list(raw_boxes),
                )

                unfamiliar_due = (
                    time.time() - last_unfamiliar_at
                    >= max(20.0, float(settings.unfamiliar_interval_s))
                )
                # Low-confidence guesses were filling Detection Reviews with the
                # wrong class and holding the API so approve/delete timed out.
                # A person moves a real detection to review. Do not auto-queue these.

                # One camera scans for unknown objects at a time. Four scans in a
                # row were stalling YOLO long enough for the boxes to drop off.
                if (
                    frame is not None
                    and unfamiliar_due
                    and not pending_saves
                    and camera_ingest_allowed(camera_id)
                    and _unfamiliar_gate.acquire(blocking=False)
                ):
                    try:
                        global _unfamiliar_global_at
                        if time.time() - _unfamiliar_global_at < 60:
                            last_unfamiliar_at = time.time()
                        else:
                            _unfamiliar_global_at = time.time()
                            last_unfamiliar_at = _unfamiliar_global_at
                            review_unfamiliar_frame(
                                client,
                                camera_id,
                                frame,
                                boxes,
                                pending_saves,
                            )
                    finally:
                        _unfamiliar_gate.release()

                if not camera_ingest_allowed(camera_id):
                    pending_saves.clear()
                    status_updates = []

                if pending_saves and save_job is None and time.time() >= save_retry_at:
                    sending_ids = list(pending_saves)
                    retrying = save_retry_at > 0.0
                    print(f"[detector] {camera_id} saving tracks {sending_ids}")
                    save_job = _start_json_job(
                        f"{api_base()}/detections/live",
                        {
                            "camera_id": camera_id,
                            "boxes": [],
                            "inference_ms": ms,
                            "model": model_label,
                            "tracker_session": tracker_session,
                            "detections": _detections_payload(
                                pending_saves,
                                sending_ids,
                                include_snapshot=not retrying,
                            ),
                        },
                        {"X-Detector-Key": settings.detector_key},
                        ids=sending_ids,
                    )

                presence_due = status_updates or (time.time() - last_presence_at >= 2.0)
                if presence_due and status_job is None and camera_ingest_allowed(camera_id):
                    last_presence_at = time.time()
                    status_job = _start_json_job(
                        f"{api_base()}/detections/live",
                        {
                            "camera_id": camera_id,
                            "boxes": [],
                            "inference_ms": ms,
                            "model": model_label,
                            "tracker_session": tracker_session,
                            "detections": [],
                            "status_updates": status_updates,
                            "visible_detection_ids": visible_detection_ids,
                        },
                        {"X-Detector-Key": settings.detector_key},
                        rows=list(status_updates),
                    )
            except Exception as exc:  # noqa: BLE001
                publish.last_error = str(exc)
                _publish_stream(camera_id, publish)
                print(f"[detector] {camera_id} error: {exc}")

            # Rate limit is the INTERVAL_S gap at the start of the loop. Do not
            # sleep leftover time after a slow infer — that delays the next frame.


# Open-vocabulary prompts that are not in weights (7). Hits go to review, not detections.
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
_unfamiliar_gate = Lock()
_unfamiliar_global_at = 0.0


def _gateway_stream_names(client: httpx.Client) -> set[str] | None:
    try:
        response = client.get(f"{settings.go2rtc_base.rstrip('/')}/api/streams", timeout=3)
        if response.status_code == 200 and isinstance(response.json(), dict):
            return set(response.json().keys())
    except Exception:
        return None
    return None


def _gateway_add_stream(client: httpx.Client, name: str, source: str) -> bool:
    try:
        response = client.put(
            f"{settings.go2rtc_base.rstrip('/')}/api/streams",
            params={"name": name, "src": source},
            timeout=5,
        )
        return response.status_code < 300
    except Exception:
        return False


def managed_camera_loop(model, model_label: str) -> None:
    """
    IP cameras added from the dashboard (Laravel /detector/cameras).
    Every MANAGED_CAMERAS_POLL_S: make sure go2rtc has each stream (it may have
    restarted), start detection for new or switched-on cameras, and stop it for
    removed or switched-off ones. Cameras from DETECTOR_STREAMS are skipped.
    """
    from urllib.parse import quote

    running: dict[str, tuple[StreamConfig, Event, Thread]] = {}
    base = settings.go2rtc_base.rstrip("/")
    with httpx.Client() as client:
        while not _stop.is_set():
            rows = None
            try:
                response = client.get(
                    f"{api_base()}/detector/cameras",
                    headers={"X-Detector-Key": settings.detector_key},
                    timeout=5,
                )
                if response.status_code == 200:
                    rows = response.json().get("cameras") or []
            except Exception:
                rows = None

            if rows is not None:
                gateway = _gateway_stream_names(client)
                wanted: dict[str, StreamConfig] = {}
                for row in rows:
                    cam = str(row.get("camera_id") or "").strip().upper()
                    src = str(row.get("go2rtc_src") or "").strip()
                    if not cam or not src or cam in _env_stream_ids:
                        continue
                    source = str(row.get("source") or "")
                    if gateway is not None and src not in gateway and source:
                        if _gateway_add_stream(client, src, source):
                            print(f"[detector] gateway: added {src} for {cam}")
                    if not row.get("detection", True):
                        continue
                    wanted[cam] = StreamConfig(
                        camera_id=cam,
                        go2rtc_src=src,
                        rtsp_url="",
                        jpeg_url=f"{base}/api/frame.jpeg?src={quote(src, safe='')}",
                        enabled=True,
                        label=str(row.get("label") or cam),
                        sector=str(row.get("sector") or settings.sector),
                    )

                for cam in list(running):
                    cfg, stop_switch, thread = running[cam]
                    if wanted.get(cam) == cfg:
                        continue
                    stop_switch.set()
                    thread.join(timeout=5)
                    running.pop(cam, None)
                    with _lock:
                        _stream_states.pop(cam, None)
                        _stream_configs[:] = [c for c in _stream_configs if c.stream_key != cam]
                    print(f"[detector] dashboard camera stopped: {cam}")

                for cam, cfg in wanted.items():
                    if cam in running:
                        continue
                    stop_switch = Event()
                    thread = Thread(
                        target=stream_worker_loop,
                        args=(cfg, model, model_label, stop_switch),
                        name=f"yolo-{cam}",
                        daemon=True,
                    )
                    thread.start()
                    running[cam] = (cfg, stop_switch, thread)
                    with _lock:
                        _stream_configs.append(cfg)
                    print(f"[detector] dashboard camera started: {cam} src={cfg.go2rtc_src} label={cfg.label}")

            _stop.wait(MANAGED_CAMERAS_POLL_S)

    for _cfg, stop_switch, thread in running.values():
        stop_switch.set()
    for _cfg, _stop_switch, thread in running.values():
        thread.join(timeout=3)


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
    """Open-vocabulary hits that are not one of the 14 CCTV classes."""
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
    reserved: bool = False,
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
    if not reserved and now - _unfamiliar_seen.get(key, 0) < 1200:
        return False
    _unfamiliar_seen[key] = now
    jpeg = encode_jpeg(frame, max_width=960, quality=70)
    if not jpeg:
        _unfamiliar_seen.pop(key, None)
        return False
    response = client.post(
        f"{api_base()}/missed-detections/unfamiliar",
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
        _unfamiliar_seen.pop(key, None)
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
    """Do not auto-queue low-confidence classes. An admin moves them from Detections."""
    del client, camera_id, frame, boxes


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
                f"{api_base()}/missed-detections/unfamiliar",
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
    model_label = f"{onnx_model_family(ONNX_WEIGHTS)} ONNX · {ONNX_WEIGHTS.name}"
    set_live_model(model, model_label)
    global _model_classes
    _model_classes = resolve_model_classes(model)
    register_model_classes(_model_classes)
    print(f"[detector] dataset classes ({len(_model_classes)}): {_model_classes}")
    print(f"[detector] class_identity_remap: {bool(settings.class_identity_remap)}")
    print("[detector] live boxes require confidence 0.80–0.98")

    try:
        configs = [c for c in load_stream_configs() if c.enabled]
    except ValueError as exc:
        raise SystemExit(f"stream config error: {exc}") from exc
    if not configs:
        print("[detector] no DETECTOR_STREAMS cameras; waiting for cameras added from the dashboard")

    global _stream_configs, _env_stream_ids
    _stream_configs = list(configs)
    _env_stream_ids = {c.stream_key for c in configs}

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

    manager = Thread(
        target=managed_camera_loop,
        args=(model, model_label),
        name="managed-cameras",
        daemon=True,
    )
    manager.start()
    threads.append(manager)

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


@app.post("/model/reload")
def reload_model(x_detector_key: str | None = Header(default=None)):
    """Load the ONNX file on disk into the running cameras."""
    if (x_detector_key or "") != settings.detector_key:
        raise HTTPException(status_code=401, detail="detector key required")
    if not ONNX_WEIGHTS.is_file():
        raise HTTPException(status_code=422, detail="best.onnx is missing")
    fresh = YOLO(str(ONNX_WEIGHTS), task="detect")
    classes = resolve_model_classes(fresh)
    # Boxes are labelled by the model's own class order, so any order works.
    # Classes the detector did not know yet (a model trained with a new class)
    # are added to the known list instead of refusing the model.
    if not classes or any(not str(name).strip() for name in classes):
        raise HTTPException(status_code=422, detail="The new model has no class names")
    added = register_model_classes(classes)
    label = f"{onnx_model_family(ONNX_WEIGHTS)} ONNX · {ONNX_WEIGHTS.name}"
    with _inference_lock:
        set_live_model(fresh, label)
        global _model_classes
        _model_classes = classes
    return {"ok": True, "model": label, "classes": classes, "new_classes": added}


class DetectionRuntimeBody(BaseModel):
    enabled: bool = False


@app.post("/runtime/detection")
def runtime_detection(body: DetectionRuntimeBody):
    """Instant Detection on/off from the dashboard. Does not wait on Laravel."""
    enabled = apply_detection_enabled(bool(body.enabled))
    return {"enabled": enabled}


@app.get("/overlay")
def overlay(camera_id: str | None = None):
    """Boxes for one camera only. Missing stream → empty boxes (fail-closed)."""
    cam, publish = _get_stream_publish(camera_id)
    model_label = _state.get("model_label") or "YOLO"
    cached = _DETECTION_SETTINGS_CACHE
    if cached is not None and not cached.get("enabled", False):
        return {
            "camera_id": cam,
            "boxes": [],
            "inference_ms": None,
            "model": model_label,
            "error": None,
            "frame_id": None,
            "frame_captured_at": None,
            "connected": bool(publish.connected) if publish is not None else False,
            "motion": {},
            "motion_active": False,
            "hud_conf": float(settings.conf),
            "detection_enabled": False,
        }
    if publish is not None:
        payload = publish.overlay_payload(cam, model_label)
        payload["detection_enabled"] = True
        return payload
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
