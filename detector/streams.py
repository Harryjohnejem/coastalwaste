"""Multi-stream camera configuration and latest-frame RTSP readers.

Each enabled stream has its own reader thread and latest-frame slot.
RTSP credentials stay in env — never returned to the browser.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from threading import Event, Lock, Thread
from typing import Any
from urllib.parse import quote

import cv2
import numpy as np


@dataclass(frozen=True)
class StreamConfig:
    """One detection/view source (lens or physical camera)."""

    camera_id: str
    go2rtc_src: str
    rtsp_url: str
    jpeg_url: str
    enabled: bool = True
    label: str = ""
    sector: str = "Sector B"

    @property
    def stream_key(self) -> str:
        return self.camera_id.upper()


_HUD_BOX_KEYS = (
    "id",
    "class",
    "confidence",
    "left",
    "top",
    "width",
    "height",
    "x",
    "y",
    "w",
    "h",
    "track_id",
    # Saved Waste Detections row for this track; the dashboard log uses it.
    "detection_id",
    "camera_id",
    "confirmed",
    "frames",
    "stage",
    "provisional",
    "held",
    "needs_label",
    "variant",
    "severity",
    "motion",
)


def hud_boxes(boxes: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    slim: list[dict[str, Any]] = []
    for box in boxes or []:
        slim.append({key: box[key] for key in _HUD_BOX_KEYS if key in box})
    return slim


def _tapo_rtsp(path: str, user: str, password: str, host: str) -> str:
    path = path if path.startswith("/") else f"/{path}"
    user_q = quote(user, safe="")
    pass_q = quote(password, safe="")
    return f"rtsp://{user_q}:{pass_q}@{host}:554{path}"


def _jpeg_url(go2rtc_base: str, src: str) -> str:
    base = go2rtc_base.rstrip("/")
    return f"{base}/api/frame.jpeg?src={quote(src, safe='')}"


def _go2rtc_rtsp_relay(src: str, go2rtc_rtsp_base: str = "rtsp://127.0.0.1:8561") -> str:
    """Local go2rtc RTSP so only go2rtc opens the camera (Tapo dual-lens starves otherwise)."""
    base = (go2rtc_rtsp_base or "rtsp://127.0.0.1:8561").rstrip("/")
    return f"{base}/{src}"


def _resolve_tapo_account(
    prefix: str,
    *,
    fallback: tuple[str, str, str],
    accounts: dict[str, tuple[str, str, str]] | None,
) -> tuple[str, str, str]:
    """Pick a camera account by env prefix. Passwords stay out of stream JSON."""
    key = (prefix or "").strip().upper().rstrip("_")
    if not key:
        return fallback
    stored = (accounts or {}).get(key) or ("", "", "")
    user = str(stored[0] or "") or os.environ.get(f"{key}_RTSP_USER", "")
    password = str(stored[1] or "") or os.environ.get(f"{key}_RTSP_PASS", "")
    host = str(stored[2] or "") or os.environ.get(f"{key}_HOST", "")
    return user, password, host


def parse_detector_streams(
    *,
    streams_json: str,
    camera_id: str,
    rtsp_url: str,
    go2rtc_frame_url: str,
    sector: str,
    tapo_user: str = "",
    tapo_pass: str = "",
    tapo_host: str = "",
    go2rtc_base: str = "http://127.0.0.1:1990",
    go2rtc_rtsp_base: str = "rtsp://127.0.0.1:8561",
    tapo_accounts: dict[str, tuple[str, str, str]] | None = None,
) -> list[StreamConfig]:
    """Parse DETECTOR_STREAMS JSON, or fall back to legacy single-stream env."""
    raw = (streams_json or "").strip()
    if raw:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"DETECTOR_STREAMS is not valid JSON: {exc}") from exc
        if not isinstance(payload, list) or not payload:
            raise ValueError("DETECTOR_STREAMS must be a non-empty JSON array")
        out: list[StreamConfig] = []
        for row in payload:
            if not isinstance(row, dict):
                raise ValueError("each DETECTOR_STREAMS entry must be an object")
            cam = str(row.get("camera_id") or row.get("id") or "").strip().upper()
            src = str(row.get("go2rtc_src") or row.get("src") or "").strip()
            if not cam or not src:
                raise ValueError("stream entries need camera_id and go2rtc_src")
            enabled = bool(row.get("enabled", True))
            label = str(row.get("label") or row.get("name") or cam)
            path = str(row.get("rtsp_path") or "").strip()
            explicit = str(row.get("rtsp_url") or "").strip()
            # Default: capture via go2rtc JPEG (not direct Tapo RTSP). Opening the
            # camera twice starves /stream6; OpenCV on Windows also often hangs on
            # go2rtc's local RTSP relay (:8561), while /api/frame.jpeg is reliable.
            use_relay = bool(row.get("use_go2rtc_relay", True))
            prefer_jpeg = bool(row.get("prefer_jpeg", True))
            row_user, row_pass, row_host = _resolve_tapo_account(
                str(row.get("tapo_env") or ""),
                fallback=(tapo_user, tapo_pass, tapo_host),
                accounts=tapo_accounts,
            )
            if explicit:
                stream_rtsp = explicit
            elif use_relay and not prefer_jpeg:
                stream_rtsp = _go2rtc_rtsp_relay(src, go2rtc_rtsp_base)
            elif (not use_relay) and path and row_user and row_pass and row_host:
                stream_rtsp = _tapo_rtsp(path, row_user, row_pass, row_host)
            else:
                stream_rtsp = ""
            jpeg = str(row.get("jpeg_url") or "").strip() or _jpeg_url(go2rtc_base, src)
            out.append(
                StreamConfig(
                    camera_id=cam,
                    go2rtc_src=src,
                    rtsp_url=stream_rtsp,
                    jpeg_url=jpeg,
                    enabled=enabled,
                    label=label,
                    sector=str(row.get("sector") or sector),
                )
            )
        return out

    # Legacy single-stream settings
    jpeg = (go2rtc_frame_url or "").strip() or _jpeg_url(go2rtc_base, "cam01")
    return [
        StreamConfig(
            camera_id=(camera_id or "CAM-01").strip().upper(),
            go2rtc_src="cam01",
            rtsp_url=(rtsp_url or "").strip(),
            jpeg_url=jpeg,
            enabled=True,
            label=(camera_id or "CAM-01").strip().upper(),
            sector=sector,
        )
    ]


class LatestFrameReader:
    """Decode continuously; keep only the newest frame (bounded to one slot)."""

    def __init__(
        self,
        name: str,
        stop_event: Event,
        reconnect_s: float = 0.5,
        capture_interval_s: float = 0.1,
    ) -> None:
        self.name = name
        self._stop = stop_event
        self.reconnect_s = max(0.1, float(reconnect_s))
        self.capture_interval_s = max(0.02, float(capture_interval_s))
        self._lock = Lock()
        self._frame: np.ndarray | None = None
        self._frame_id = 0
        self._captured_at: float | None = None
        self._connected = False
        self._last_error: str | None = None
        self._thread: Thread | None = None
        self._rtsp_url = ""
        self._jpeg_url = ""
        self._http: Any = None

    def start(self, rtsp_url: str = "", jpeg_url: str = "") -> None:
        self._rtsp_url = (rtsp_url or "").strip()
        self._jpeg_url = (jpeg_url or "").strip()
        if self._thread is not None:
            return
        self._thread = Thread(
            target=self._read_loop,
            name=f"frame-{self.name}",
            daemon=True,
        )
        self._thread.start()

    @property
    def connected(self) -> bool:
        with self._lock:
            return self._connected

    @property
    def last_error(self) -> str | None:
        with self._lock:
            return self._last_error

    def latest(self) -> tuple[np.ndarray | None, int | None, float | None]:
        with self._lock:
            if self._frame is None or self._captured_at is None:
                return None, None, None
            return self._frame.copy(), self._frame_id, self._captured_at

    def _set_frame(self, frame: np.ndarray) -> None:
        with self._lock:
            self._frame_id += 1
            self._frame = frame
            self._captured_at = time.time()
            self._connected = True
            self._last_error = None

    def _set_error(self, message: str) -> None:
        with self._lock:
            self._connected = False
            self._last_error = message

    def _read_loop(self) -> None:
        """Prefer RTSP; fall back to go2rtc JPEG when RTSP will not open."""
        if self._rtsp_url:
            self._rtsp_loop_with_jpeg_fallback()
        elif self._jpeg_url:
            self._jpeg_loop()
        else:
            self._set_error("no rtsp_url or jpeg_url configured")

    def _jpeg_client(self) -> Any:
        if self._http is None:
            import httpx

            self._http = httpx.Client(timeout=5.0)
        return self._http

    def _close_jpeg_client(self) -> None:
        client = self._http
        self._http = None
        if client is not None:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass

    def _grab_jpeg_once(self) -> np.ndarray | None:
        if not self._jpeg_url:
            return None
        try:
            response = self._jpeg_client().get(self._jpeg_url)
            response.raise_for_status()
            raw = response.content or b""
            if len(raw) < 64:
                self._set_error("jpeg: empty or incomplete frame from go2rtc")
                return None
            arr = np.frombuffer(raw, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                self._set_error("jpeg: decode failed")
                return None
            return img
        except Exception as exc:  # noqa: BLE001
            self._close_jpeg_client()
            self._set_error(f"jpeg: {exc}")
            return None

    def _rtsp_loop_with_jpeg_fallback(self) -> None:
        cap: cv2.VideoCapture | None = None
        rtsp_failures = 0
        while not self._stop.is_set():
            if cap is None or not cap.isOpened():
                cap = cv2.VideoCapture(self._rtsp_url, cv2.CAP_FFMPEG)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                if not cap.isOpened():
                    self._set_error("rtsp open failed")
                    if cap is not None:
                        cap.release()
                    cap = None
                    rtsp_failures += 1
                    # After a few RTSP failures, keep the pipeline alive via JPEG.
                    if self._jpeg_url and rtsp_failures >= 2:
                        img = self._grab_jpeg_once()
                        if img is not None:
                            self._set_frame(img)
                    self._stop.wait(self.reconnect_s)
                    continue
            ok, frame = cap.read()
            if not ok or frame is None:
                self._set_error("rtsp read failed")
                cap.release()
                cap = None
                rtsp_failures += 1
                if self._jpeg_url and rtsp_failures >= 2:
                    img = self._grab_jpeg_once()
                    if img is not None:
                        self._set_frame(img)
                self._stop.wait(self.reconnect_s)
                continue
            rtsp_failures = 0
            self._set_frame(frame)
        if cap is not None:
            cap.release()
        self._close_jpeg_client()

    def _jpeg_loop(self) -> None:
        while not self._stop.is_set():
            img = self._grab_jpeg_once()
            if img is not None:
                self._set_frame(img)
                self._stop.wait(self.capture_interval_s)
            else:
                self._stop.wait(self.reconnect_s)
        self._close_jpeg_client()


def new_byte_tracker() -> Any:
    """Fresh ByteTrack instance — never share across streams.

    Buffer and match thresholds are looser than the Ultralytics default so a
    still piece of waste keeps the same ID through occlusion and missed YOLO
    looks, instead of a new ID that falsely looks like a cleanup.
    """
    from ultralytics.trackers.byte_tracker import BYTETracker
    from ultralytics.utils import YAML, IterableSimpleNamespace
    from ultralytics.utils.checks import check_yaml

    cfg = IterableSimpleNamespace(**YAML.load(check_yaml("bytetrack.yaml")))
    cfg.track_high_thresh = 0.25
    cfg.track_low_thresh = 0.05
    cfg.new_track_thresh = 0.50
    cfg.track_buffer = 180
    # Cost is 1 − IoU. A higher thresh keeps the same ID through missed looks.
    cfg.match_thresh = 0.90
    cfg.fuse_score = True
    return BYTETracker(args=cfg)


def annotate_detection_stages(
    boxes: list[dict[str, Any]],
    tracks: dict[int, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Mark each box for the HUD: detected → confirming → recorded.

    Visual overlay uses these immediately; Laravel save still waits for
    confirmation / record_conf.
    """
    for box in boxes:
        track_id = box.get("track_id")
        state = tracks.get(track_id) if track_id is not None else None
        if state and (state.get("recorded") or state.get("saved_id")):
            box["stage"] = "recorded"
        elif box.get("provisional") and not box.get("confirmed"):
            box["stage"] = "detected"
        elif box.get("confirmed"):
            box["stage"] = "confirming"
        elif track_id is not None:
            box["stage"] = "confirming"
        else:
            box["stage"] = "detected"
        box["display"] = True
    return boxes


def draw_detection_boxes(frame: np.ndarray, boxes: list[dict[str, Any]]) -> np.ndarray:
    """Draw YOLO boxes on the same frame that was inferred (percent coords)."""
    if frame is None or frame.size == 0:
        return frame
    vis = frame.copy()
    height, width = vis.shape[:2]
    for box in boxes or []:
        left = float(box.get("left") or 0) / 100.0 * width
        top = float(box.get("top") or 0) / 100.0 * height
        bw = float(box.get("width") or 0) / 100.0 * width
        bh = float(box.get("height") or 0) / 100.0 * height
        x1 = max(0, int(left))
        y1 = max(0, int(top))
        x2 = min(width - 1, int(left + bw))
        y2 = min(height - 1, int(top + bh))
        if x2 <= x1 or y2 <= y1:
            continue
        stage = str(box.get("stage") or "")
        confirmed = bool(box.get("confirmed"))
        provisional = bool(box.get("provisional"))
        if confirmed or stage == "recorded":
            color = (60, 200, 90)
        elif provisional:
            color = (40, 160, 230)
        else:
            color = (80, 180, 255)
        cv2.rectangle(vis, (x1, y1), (x2, y2), color, 2)
        label = str(box.get("class") or "waste")
        conf = box.get("confidence")
        tid = box.get("track_id")
        parts = [label]
        if conf is not None:
            parts.append(f"{float(conf):.2f}")
        if tid is not None:
            parts.append(f"ID:{tid}")
        text = " · ".join(parts)
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        ty = max(0, y1 - th - 6)
        cv2.rectangle(vis, (x1, ty), (x1 + tw + 6, y1), color, -1)
        cv2.putText(
            vis,
            text,
            (x1 + 3, y1 - 4),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (20, 20, 20),
            1,
            cv2.LINE_AA,
        )
    return vis


def encode_jpeg(frame: np.ndarray, max_width: int = 960, quality: int = 70) -> bytes | None:
    if frame is None or frame.size == 0:
        return None
    vis = frame
    height, width = vis.shape[:2]
    if width > max_width:
        vis = cv2.resize(vis, (max_width, int(height * max_width / width)))
    ok, buf = cv2.imencode(".jpg", vis, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        return None
    return buf.tobytes()


@dataclass
class StreamPublishState:
    """Thread-safe snapshot published to FastAPI overlay/health."""

    ready: bool = False
    last_ms: int | None = None
    last_boxes: list[dict[str, Any]] = field(default_factory=list)
    raw_boxes: list[dict[str, Any]] = field(default_factory=list)
    filtered_boxes: list[dict[str, Any]] = field(default_factory=list)
    last_error: str | None = None
    frames: int = 0
    last_jpeg: bytes | None = None
    # Same inference frame with boxes burned in — used for synced live view.
    annotated_jpeg: bytes | None = None
    frame_id: int | None = None
    frame_captured_at: float | None = None
    frame_w: int | None = None
    frame_h: int | None = None
    frame_source: str = "none"
    motion: dict[str, Any] = field(default_factory=dict)
    track_trace: list[dict[str, Any]] = field(default_factory=list)
    connected: bool = False
    go2rtc_src: str = ""
    # Near-real-time overlay timing (seconds since epoch / ms)
    overlay_published_at: float | None = None
    detect_to_publish_ms: int | None = None
    inference_fps: float | None = None
    hud_conf: float | None = None

    def overlay_payload(self, camera_id: str, model_label: str) -> dict[str, Any]:
        age_ms = None
        if self.overlay_published_at is not None:
            age_ms = max(0, int((time.time() - self.overlay_published_at) * 1000))
        motion = dict(self.motion) if self.motion else {}
        return {
            "camera_id": camera_id,
            "boxes": hud_boxes(self.last_boxes),
            "inference_ms": self.last_ms,
            "model": model_label,
            "error": self.last_error,
            "frame_id": self.frame_id,
            "frame_captured_at": self.frame_captured_at,
            "frame_width": self.frame_w,
            "frame_height": self.frame_h,
            "frame_source": self.frame_source,
            "connected": self.connected,
            "go2rtc_src": self.go2rtc_src,
            "overlay_published_at": self.overlay_published_at,
            "detect_to_publish_ms": self.detect_to_publish_ms,
            "inference_fps": self.inference_fps,
            "overlay_age_ms": age_ms,
            "annotated": self.annotated_jpeg is not None,
            "motion": {
                "has_motion": bool(motion.get("has_motion")),
                "region_count": int(motion.get("region_count") or 0),
            },
            "motion_active": bool(motion.get("has_motion")),
            "hud_conf": self.hud_conf,
        }
