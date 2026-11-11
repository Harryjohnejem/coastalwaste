"""Motion overlap and disappearance bookkeeping.

OpenCV MOG2 motion detection complements YOLOv11 + ByteTrack. Motion never
creates a waste detection and never gates YOLO inference. A missing track is
marked for an inferred removal only after several processed frames, and only
while the camera stream is healthy. Motion still inside the last box pauses
that count so one missed YOLO frame is not treated as cleaning.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np


def hue_histogram(frame, box: dict[str, Any] | None) -> list[float] | None:
    """16-bin hue histogram for a box. Used only as a weak appearance hint."""
    if frame is None or not box:
        return None
    frame_h, frame_w = frame.shape[:2]
    left = float(box.get("left") or 0) / 100.0 * frame_w
    top = float(box.get("top") or 0) / 100.0 * frame_h
    width = float(box.get("width") or 0) / 100.0 * frame_w
    height = float(box.get("height") or 0) / 100.0 * frame_h
    x1 = max(0, int(left))
    y1 = max(0, int(top))
    x2 = min(frame_w, int(left + width))
    y2 = min(frame_h, int(top + height))
    if x2 - x1 < 4 or y2 - y1 < 4:
        return None
    crop = frame[y1:y2, x1:x2]
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0], None, [16], [0, 180])
    total = float(hist.sum())
    if total <= 0:
        return None
    return [round(float(value) / total, 5) for value in hist.flatten()]


def box_motion_fraction(mask: np.ndarray | None, box: dict[str, Any] | None) -> float:
    if mask is None or not box or mask.size == 0:
        return 0.0
    frame_h, frame_w = mask.shape[:2]
    left = float(box.get("left") or 0) / 100.0 * frame_w
    top = float(box.get("top") or 0) / 100.0 * frame_h
    width = float(box.get("width") or 0) / 100.0 * frame_w
    height = float(box.get("height") or 0) / 100.0 * frame_h
    x1 = max(0, int(left))
    y1 = max(0, int(top))
    x2 = min(frame_w, int(left + width))
    y2 = min(frame_h, int(top + height))
    if x2 <= x1 or y2 <= y1:
        return 0.0
    roi = mask[y1:y2, x1:x2]
    if roi.size == 0:
        return 0.0
    return float(np.count_nonzero(roi)) / float(roi.size)


def _frame_valid(frame) -> bool:
    if frame is None:
        return False
    try:
        if not isinstance(frame, np.ndarray) or frame.size == 0:
            return False
        if len(frame.shape) < 2:
            return False
        height, width = int(frame.shape[0]), int(frame.shape[1])
        return height >= 2 and width >= 2
    except Exception:  # noqa: BLE001
        return False


@dataclass(frozen=True)
class MotionRegion:
    """One contour-derived motion blob after area filtering."""

    x: int
    y: int
    width: int
    height: int
    area: int

    def as_dict(self) -> dict[str, int]:
        return {
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "area": self.area,
        }


@dataclass
class MotionResult:
    """Snapshot of scene motion for one processed frame."""

    has_motion: bool = False
    region_count: int = 0
    regions: list[MotionRegion] = field(default_factory=list)
    mask: np.ndarray | None = None
    foreground_pixels: int = 0
    frame_shape: tuple[int, int] | None = None
    reset: bool = False

    def summary(self) -> dict[str, Any]:
        return {
            "has_motion": self.has_motion,
            "region_count": self.region_count,
            "foreground_pixels": self.foreground_pixels,
            "regions": [region.as_dict() for region in self.regions[:20]],
            "frame_shape": list(self.frame_shape) if self.frame_shape else None,
            "reset": self.reset,
        }


class SceneMotion:
    """MOG2 foreground mask with morphology, contours, and safe resets.

    Shadows (MOG2 value 127) are dropped. Speckle is opened/closed away.
    Contours below ``min_area`` are ignored so wind/noise does not count.
    """

    def __init__(
        self,
        min_area: int = 800,
        history: int = 120,
        var_threshold: float = 40.0,
        detect_shadows: bool = True,
        morph_kernel: int = 5,
        learning_rate: float = -1.0,
    ) -> None:
        self.min_area = max(0, int(min_area))
        self.history = max(1, int(history))
        self.var_threshold = float(var_threshold)
        self.detect_shadows = bool(detect_shadows)
        self.morph_kernel = max(1, int(morph_kernel) | 1)  # odd kernel size
        self.learning_rate = float(learning_rate)
        self._frame_shape: tuple[int, int] | None = None
        self._sub: Any = None
        self._kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (self.morph_kernel, self.morph_kernel),
        )
        self.reset()

    def reset(self) -> None:
        """Rebuild the background model (reconnect or resolution change)."""
        self._sub = cv2.createBackgroundSubtractorMOG2(
            history=self.history,
            varThreshold=self.var_threshold,
            detectShadows=self.detect_shadows,
        )
        self._frame_shape = None

    def analyze(self, frame) -> MotionResult:
        """Run motion detection once on a decoded BGR frame.

        Returns an empty result for missing/invalid frames without raising.
        """
        if not _frame_valid(frame):
            return MotionResult()

        height, width = int(frame.shape[0]), int(frame.shape[1])
        shape = (height, width)
        did_reset = False
        if self._frame_shape is not None and self._frame_shape != shape:
            self.reset()
            did_reset = True
        if self._sub is None:
            self.reset()
            did_reset = True

        try:
            # Work on a grayscale view when possible to avoid extra color noise.
            if len(frame.shape) == 3 and frame.shape[2] >= 3:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                raw = self._sub.apply(gray, learningRate=self.learning_rate)
            else:
                raw = self._sub.apply(frame, learningRate=self.learning_rate)
        except Exception:  # noqa: BLE001
            self.reset()
            return MotionResult(reset=True)

        self._frame_shape = shape

        # MOG2 marks shadows as 127. Keep only bright foreground.
        _threshold, binary = cv2.threshold(raw, 200, 255, cv2.THRESH_BINARY)
        binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, self._kernel)
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, self._kernel)

        regions: list[MotionRegion] = []
        contours, _hierarchy = cv2.findContours(
            binary,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE,
        )
        filtered = np.zeros_like(binary)
        for contour in contours:
            area = int(cv2.contourArea(contour))
            if area < self.min_area:
                continue
            x, y, w, h = cv2.boundingRect(contour)
            regions.append(MotionRegion(x=x, y=y, width=w, height=h, area=area))
            cv2.drawContours(filtered, [contour], -1, 255, thickness=-1)

        # Sort largest first for stable debug output.
        regions.sort(key=lambda row: row.area, reverse=True)
        fg_pixels = int(np.count_nonzero(filtered))
        # Warm-up / empty: keep a zero mask so callers can still index it.
        if not regions:
            return MotionResult(
                has_motion=False,
                region_count=0,
                regions=[],
                mask=filtered,
                foreground_pixels=0,
                frame_shape=shape,
                reset=did_reset,
            )

        return MotionResult(
            has_motion=True,
            region_count=len(regions),
            regions=regions,
            mask=filtered,
            foreground_pixels=fg_pixels,
            frame_shape=shape,
            reset=did_reset,
        )

    def mask(self, frame) -> np.ndarray:
        """Binary motion mask (empty array when nothing significant moved)."""
        result = self.analyze(frame)
        if result.mask is not None:
            return result.mask
        if _frame_valid(frame):
            return np.zeros(frame.shape[:2], dtype=np.uint8)
        return np.zeros((1, 1), dtype=np.uint8)

    def fraction(self, mask: np.ndarray | None, box: dict[str, Any] | None) -> float:
        return box_motion_fraction(mask, box)


class PresenceBook:
    """Per saved detection, not per global track id."""

    def __init__(self, absence_frames: int = 8, motion_hold: float = 0.12) -> None:
        self.absence_frames = max(1, int(absence_frames))
        self.motion_hold = float(motion_hold)
        self.watch: dict[int, dict[str, Any]] = {}

    def step(
        self,
        active: dict[int, dict[str, Any]],
        motion_mask: np.ndarray | None,
        stream_ok: bool,
    ) -> list[dict[str, Any]]:
        seen: set[int] = set()
        updates: list[dict[str, Any]] = []
        for info in active.values():
            detection_id = info.get("detection_id")
            if not isinstance(detection_id, int):
                continue
            seen.add(detection_id)
            row = self.watch.setdefault(
                detection_id,
                {"absent": 0, "sent": False, "last_box": None, "class": None},
            )
            if row.get("sent"):
                updates.append({
                    "detection_id": detection_id,
                    "status": "Present",
                    "reason": "visible_again",
                    "class": info.get("class"),
                })
            row["absent"] = 0
            row["sent"] = False
            row["last_box"] = info.get("box")
            row["class"] = info.get("class")

        if not stream_ok:
            return []

        for detection_id, row in self.watch.items():
            if detection_id in seen or row.get("sent"):
                continue
            if box_motion_fraction(motion_mask, row.get("last_box")) >= self.motion_hold:
                continue
            row["absent"] = int(row.get("absent") or 0) + 1
            if row["absent"] < self.absence_frames:
                continue
            row["sent"] = True
            updates.append({
                "detection_id": detection_id,
                "status": "Confirmed Cleaned",
                "reason": "inferred_disappearance",
                "class": row.get("class"),
            })
        return updates
