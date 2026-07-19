"""
Coastal waste detector — YOLOv8-World (open-vocab / text embeddings).

Pulls frames from go2rtc, runs YOLO-World with waste class prompts,
posts live boxes + log hits to the Laravel API.
"""

from __future__ import annotations

import os
import time
from contextlib import asynccontextmanager
from threading import Event, Thread
from typing import Any

import cv2
import httpx
import numpy as np
from fastapi import FastAPI
from pydantic_settings import BaseSettings, SettingsConfigDict
from ultralytics import YOLOWorld


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    go2rtc_frame_url: str = "http://127.0.0.1:1984/api/frame.jpeg?src=cam01"
    camera_id: str = "CAM-01"
    sector: str = "Sector B"
    api_base: str = "http://127.0.0.1:8000/api"
    detector_key: str = "tidalwatch-detector-local"
    interval_s: float = 1.5
    conf: float = 0.25
    log_cooldown_s: float = 12.0
    model_name: str = "yolov8s-worldv2.pt"
    host: str = "127.0.0.1"
    port: int = 8090


# Open-vocabulary waste prompts (text embeddings inside YOLO-World)
WASTE_CLASSES = [
    "plastic bottle",
    "plastic bag",
    "fishing net",
    "styrofoam",
    "trash bag",
    "can",
    "cup",
    "debris",
    "litter",
    "person",
    "boat",
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
_state: dict[str, Any] = {
    "ready": False,
    "last_ms": None,
    "last_boxes": [],
    "last_error": None,
    "frames": 0,
}


def grab_frame(url: str) -> np.ndarray | None:
    try:
        with httpx.Client(timeout=5.0) as client:
            r = client.get(url)
            r.raise_for_status()
            arr = np.frombuffer(r.content, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            return img
    except Exception as exc:  # noqa: BLE001
        _state["last_error"] = f"frame: {exc}"
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
    print(f"[detector] loading {settings.model_name} …")
    model = YOLOWorld(settings.model_name)
    model.set_classes(WASTE_CLASSES)
    _state["ready"] = True
    print(f"[detector] ready · classes={WASTE_CLASSES}")

    last_logged: dict[str, float] = {}

    with httpx.Client(timeout=8.0) as client:
        while not _stop.is_set():
            t0 = time.perf_counter()
            frame = grab_frame(settings.go2rtc_frame_url)
            if frame is None:
                _stop.wait(settings.interval_s)
                continue

            try:
                results = model.predict(frame, conf=settings.conf, verbose=False)
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
                        "model": "YOLO-World · waste",
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


app = FastAPI(title="TidalWatch YOLO Detector", lifespan=lifespan)


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
        "model": settings.model_name,
    }


@app.get("/overlay")
def overlay():
    return {
        "camera_id": settings.camera_id,
        "boxes": _state["last_boxes"],
        "inference_ms": _state["last_ms"],
        "model": "YOLO-World · waste",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )
