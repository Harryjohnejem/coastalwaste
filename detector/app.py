"""
Coastal waste detector — YOLOv8-World (open-vocab / text embeddings).

Pulls frames from go2rtc, runs YOLO-World with waste class prompts,
posts live boxes + log hits to the Laravel API.
"""

from __future__ import annotations

import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Any

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic_settings import BaseSettings, SettingsConfigDict
from ultralytics import YOLO, YOLOWorld


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    go2rtc_frame_url: str = "http://127.0.0.1:1990/api/frame.jpeg?src=cam01"
    rtsp_url: str = ""
    camera_id: str = "CAM-01"
    sector: str = "Sector B"
    api_base: str = "http://127.0.0.1:8000/api"
    detector_key: str = "tidalwatch-detector-local"
    interval_s: float = 1.5
    conf: float = 0.25
    log_cooldown_s: float = 12.0
    model_name: str = "yolov8s-worldv2.pt"
    host: str = "127.0.0.1"
    port: int = 8092


# Tight prompt set for YOLO-World (too many similar names lowers accuracy).
# LOCAL DATASET classes first (their 99.81 mAP taxonomy), then coastal extras.
WASTE_CLASSES = [
    "plastic bottle",
    "plastic bag",
    "plastic cup",
    "plastic wrapper",
    "plastic straw",
    "can",
    "cardboard",
    "paper cup",
    "paper bag",
    "paper drink carton",
    "glass bottle",
    "styrofoam",
    "face mask",
    "fishing net",
    "trash bag",
    "cigarette",
]

SEVERITY = {
    "plastic bottle": "alert",
    "plastic bag": "alert",
    "fishing net": "warn",
    "styrofoam": "alert",
    "trash bag": "alert",
    "can": "alert",
    "cup": "alert",
    "debris": "warn",
    "litter": "warn",
    "person": "info",
    "boat": "info",
}

LABEL = {
    "plastic bottle": "Plastic bottle",
    "plastic bag": "Plastic bag",
    "fishing net": "Abandoned fishing net",
    "styrofoam": "Styrofoam fragments",
    "trash bag": "Trash bag",
    "can": "Metal can",
    "cup": "Disposable cup",
    "debris": "Coastal debris",
    "litter": "Litter",
    "person": "Person",
    "boat": "Vessel",
}


settings = Settings()
_stop = Event()
_lock = Lock()
_state: dict[str, Any] = {
    "ready": False,
    "last_ms": None,
    "last_boxes": [],
    "last_error": None,
    "frames": 0,
    "catalog": [],
    "last_jpeg": None,
    "model_label": "YOLO-World",
}
_rtsp_cap: cv2.VideoCapture | None = None
CATALOG_PATH = Path(__file__).with_name("roboflow_datasets.json")
TRAINED_WEIGHTS = Path(__file__).with_name("weights") / "trained" / "best.pt"


def load_dataset_catalog() -> tuple[list[dict[str, str]], list[str]]:
    """Original cleaned_dataset + 7 new Roboflow class names for YOLO-World."""
    rows: list[dict[str, str]] = []
    prompts: list[str] = []
    seen = {c.lower() for c in WASTE_CLASSES}
    junk = {"0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "object", "all"}
    if CATALOG_PATH.is_file():
        try:
            data = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            data = {}
        for group in ("existing", "new"):
            for row in data.get(group) or []:
                if not isinstance(row, dict) or not row.get("model_id"):
                    continue
                rows.append(
                    {
                        "name": str(row.get("name") or ""),
                        "model_id": str(row.get("model_id") or ""),
                        "group": group,
                    }
                )
                for raw in row.get("classes") or []:
                    prompt = " ".join(str(raw).replace("_", " ").replace("-", " ").split()).lower()
                    if len(prompt) < 3 or prompt in junk or prompt in seen:
                        continue
                    seen.add(prompt)
                    prompts.append(prompt)
    classes = list(WASTE_CLASSES)
    # Keep YOLO-World on the curated list. Extra catalog names are listed in /datasets only.
    _ = prompts
    return rows, classes


def grab_frame_rtsp(url: str) -> np.ndarray | None:
    global _rtsp_cap
    try:
        if _rtsp_cap is None or not _rtsp_cap.isOpened():
            _rtsp_cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
            _rtsp_cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        ok, frame = _rtsp_cap.read()
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


def grab_frame(url: str) -> np.ndarray | None:
    try:
        with httpx.Client(timeout=5.0) as client:
            r = client.get(url)
            r.raise_for_status()
            arr = np.frombuffer(r.content, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is not None:
                return img
    except Exception:  # noqa: BLE001
        pass
    if settings.rtsp_url.strip():
        frame = grab_frame_rtsp(settings.rtsp_url.strip())
        if frame is not None:
            _state["last_error"] = None
            return frame
    _state["last_error"] = "no camera frame — start go2rtc (port 1990) or check RTSP"
    return None


def boxes_from_result(result, conf_min: float) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if result.boxes is None or len(result.boxes) == 0:
        return out

    names = result.names or {}
    h, w = result.orig_shape[:2]
    for box in result.boxes:
        score = float(box.conf[0])
        if score < conf_min:
            continue
        cls_id = int(box.cls[0])
        raw = str(names.get(cls_id, cls_id)).lower()
        x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
        label = LABEL.get(raw, raw.title())
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


def worker() -> None:
    catalog, classes = load_dataset_catalog()
    print(f"[detector] datasets: {len(catalog)} (1 original + 7 new)")
    for row in catalog:
        print(f"  · {row['name']} ({row['model_id']})")

    if TRAINED_WEIGHTS.is_file():
        print(f"[detector] loading trained weights {TRAINED_WEIGHTS}")
        model = YOLO(str(TRAINED_WEIGHTS))
        model_label = "Roboflow labels · local YOLOv8n"
        use_world = False
    else:
        print(f"[detector] loading {settings.model_name} (train_from_roboflow.py not finished yet)")
        model = YOLOWorld(settings.model_name)
        model.set_classes(classes)
        model_label = "YOLO-World (waiting for local train)"
        use_world = True

    _state["ready"] = True
    _state["catalog"] = catalog
    _state["model_label"] = model_label
    print(f"[detector] ready · {model_label}")
    _ = use_world

    last_logged: dict[str, float] = {}

    with httpx.Client(timeout=8.0) as client:
        while not _stop.is_set():
            t0 = time.perf_counter()
            frame = grab_frame(settings.go2rtc_frame_url)
            if frame is None:
                _stop.wait(settings.interval_s)
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
                results = model.predict(
                    frame,
                    conf=settings.conf,
                    iou=0.5,
                    imgsz=640,
                    agnostic_nms=True,
                    max_det=20,
                    verbose=False,
                )
                boxes = boxes_from_result(results[0], settings.conf) if results else []
                ms = int((time.perf_counter() - t0) * 1000)
                _state["last_ms"] = ms
                _state["last_boxes"] = boxes
                _state["last_error"] = None
                _state["frames"] += 1

                # Only persist log rows on cooldown / new class
                now = time.time()
                detections_to_log = []
                for row in summarize(boxes):
                    key = row["class"]
                    prev = last_logged.get(key, 0.0)
                    if now - prev >= settings.log_cooldown_s:
                        last_logged[key] = now
                        detections_to_log.append(row)

                payload_boxes = boxes
                client.post(
                    f"{settings.api_base}/detections/live",
                    json={
                        "camera_id": settings.camera_id,
                        "boxes": payload_boxes,
                        "inference_ms": ms,
                        "model": _state.get("model_label") or "YOLO",
                        "detections": [
                            {
                                "class": row["class"],
                                "confidence": row["confidence"],
                                "count": row["count"],
                                "severity": row["severity"],
                                "sector": settings.sector,
                                "subtitle": (
                                    f"{row['count']} object"
                                    f"{'s' if row['count'] != 1 else ''} · "
                                    f"YOLO · {settings.camera_id}"
                                ),
                            }
                            for row in detections_to_log
                        ],
                    },
                    headers={"X-Detector-Key": settings.detector_key},
                )
            except Exception as exc:  # noqa: BLE001
                _state["last_error"] = str(exc)
                print(f"[detector] error: {exc}")

            _stop.wait(settings.interval_s)


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
def overlay():
    return {
        "camera_id": settings.camera_id,
        "boxes": _state["last_boxes"],
        "inference_ms": _state["last_ms"],
        "model": _state.get("model_label") or "YOLO",
        "error": _state["last_error"],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )
