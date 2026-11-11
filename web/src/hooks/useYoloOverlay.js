import { useEffect, useRef, useState } from 'react';
import * as detectionsApi from '../api/detections';
import { useCameraStore } from '../stores/useCameraStore';
import { OVERLAY_POLL_MS, OVERLAY_START_DELAY_MS } from '../constants';

const DETECTOR_OVERLAY_URL =
  import.meta.env.VITE_DETECTOR_OVERLAY_URL || 'http://127.0.0.1:8092/overlay';

export async function fetchOverlay(cameraId) {
  const id = encodeURIComponent(String(cameraId || 'CAM-01'));
  try {
    const sep = DETECTOR_OVERLAY_URL.includes('?') ? '&' : '?';
    const res = await fetch(`${DETECTOR_OVERLAY_URL}${sep}camera_id=${id}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.boxes)) {
        const returned = String(data.camera_id || '').toUpperCase();
        const wanted = String(cameraId || '').toUpperCase();
        if (!returned || !wanted || returned === wanted) return data;
      }
    }
  } catch {
    /* Detector unreachable — fall through to Laravel overlay cache. */
  }
  try {
    const data = await detectionsApi.getLiveOverlay(cameraId);
    if (data && Array.isArray(data.boxes)) return data;
  } catch {
    return null;
  }
  return null;
}

export function overlayMetaFromPayload(data, cameraId) {
  return {
    cameraId: data.camera_id || cameraId,
    frameId: data.frame_id ?? null,
    frameCapturedAt: data.frame_captured_at ?? null,
    overlayPublishedAt: data.overlay_published_at ?? null,
    detectToPublishMs: data.detect_to_publish_ms ?? data.inference_ms ?? null,
    inferenceFps: data.inference_fps ?? null,
    overlayAgeMs: data.overlay_age_ms ?? null,
    connected: data.connected !== false && !data.error,
    error: data.error || null,
    motionActive: Boolean(data.motion_active),
    frameSource: data.frame_source ?? null,
    hudConf: data.hud_conf ?? null,
    polledAt: Date.now() / 1000,
  };
}

const DETECTOR_OVERLAY_URL =
  import.meta.env.VITE_DETECTOR_OVERLAY_URL || 'http://127.0.0.1:8092/overlay';

async function fetchOverlay(cameraId) {
  try {
    const res = await fetch(DETECTOR_OVERLAY_URL, {
      signal: AbortSignal.timeout(600),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.boxes)) return data;
    }
  } catch {
    /* detector not running — do not hit Vite /overlay (that spams ECONNREFUSED) */
  }
  try {
    return await detectionsApi.getLiveOverlay(cameraId);
  } catch {
    return { boxes: [] };
  }
}

/**
 * Local overlay poll for one camera (grid tiles). Does not touch the
 * active-camera store, so CAM-01 and CAM-02 never share boxes.
 */
export function useStreamOverlay({ enabled, cameraId, intervalMs = OVERLAY_POLL_MS }) {
  const [state, setState] = useState({ boxes: [], meta: null });

  useEffect(() => {
    if (!enabled || !cameraId) {
      setState({ boxes: [], meta: null });
      return undefined;
    }

    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const data = await fetchOverlay(cameraId);
        if (cancelled) return;
        if (!data || (data.error && !Array.isArray(data.boxes))) {
          setState({
            boxes: [],
            meta: overlayMetaFromPayload({
              camera_id: cameraId,
              boxes: [],
              connected: false,
              error: data?.error || 'Detector is not responding.',
            }, cameraId),
          });
          return;
        }
        const returned = String(data.camera_id || '').toUpperCase();
        const wanted = String(cameraId || '').toUpperCase();
        if (returned && wanted && returned !== wanted) return;
        setState({
          boxes: Array.isArray(data.boxes) ? data.boxes : [],
          meta: overlayMetaFromPayload(data, cameraId),
        });
      } catch {
        if (!cancelled) {
          setState({
            boxes: [],
            meta: overlayMetaFromPayload({
              camera_id: cameraId,
              boxes: [],
              connected: false,
              error: 'Detector is not responding.',
            }, cameraId),
          });
        }
      } finally {
        inFlight = false;
      }
    };

    const startId = setTimeout(() => {
      if (cancelled) return;
      tick();
      pollId = setInterval(tick, intervalMs);
    }, OVERLAY_START_DELAY_MS);
    let pollId;
    return () => {
      cancelled = true;
      clearTimeout(startId);
      clearInterval(pollId);
    };
  }, [enabled, cameraId, intervalMs]);

  return state;
}

/**
 * Poll YOLO live boxes for the HUD overlay.
 * Boxes are visual detections (not waiting for DB confirmation).
 */
export function useYoloOverlay({ enabled, cameraId }) {
  const setOverlayBoxes = useCameraStore((s) => s.setOverlayBoxes);
  const setOverlayKnown = useCameraStore((s) => s.setOverlayKnown);
  const setInferenceMs = useCameraStore((s) => s.setInferenceMs);
  const setLiveModel = useCameraStore((s) => s.setLiveModel);
  const setOverlayMeta = useCameraStore((s) => s.setOverlayMeta);
  const overlayNonce = useCameraStore((s) => s.overlayNonce);
  const tickRef = useRef(async () => {});

  useEffect(() => {
    if (!enabled || !cameraId) {
      setOverlayBoxes([]);
      setOverlayKnown(false);
      setInferenceMs(null);
      setLiveModel(null);
      setOverlayMeta(null);
      return undefined;
    }

    // Clear previous camera's boxes immediately so they never paint on the new stream.
    setOverlayBoxes([]);
    setOverlayKnown(false);
    setOverlayMeta(null);

    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const data = await fetchOverlay(cameraId);
        if (cancelled) return;
        if (!data || (data.error && !Array.isArray(data.boxes))) {
          setOverlayBoxes([]);
          setOverlayKnown(true);
          setInferenceMs(null);
          setOverlayMeta(overlayMetaFromPayload({
            camera_id: cameraId,
            boxes: [],
            connected: false,
            error: data?.error || 'Detector is not responding.',
          }, cameraId));
          return;
        }
        const returned = String(data.camera_id || '').toUpperCase();
        const wanted = String(cameraId || '').toUpperCase();
        if (returned && wanted && returned !== wanted) return;

        const boxes = Array.isArray(data.boxes) ? data.boxes : [];
        setOverlayBoxes(boxes);
        setOverlayKnown(true);
        setInferenceMs(data.inference_ms ?? data.detect_to_publish_ms ?? null);
        setLiveModel(data.model ?? null);
        setOverlayMeta(overlayMetaFromPayload(data, cameraId));
      } catch {
        if (!cancelled) {
          setOverlayBoxes([]);
          setOverlayKnown(true);
          setOverlayMeta(overlayMetaFromPayload({
            camera_id: cameraId,
            boxes: [],
            connected: false,
            error: 'Detector is not responding.',
          }, cameraId));
        }
      } finally {
        inFlight = false;
      }
    };

    tickRef.current = tick;

    const startId = setTimeout(() => {
      if (cancelled) return;
      tick();
      pollId = setInterval(tick, OVERLAY_POLL_MS);
    }, OVERLAY_START_DELAY_MS);
    let pollId;
    return () => {
      cancelled = true;
      clearTimeout(startId);
      clearInterval(pollId);
      setOverlayBoxes([]);
      setOverlayKnown(false);
      setInferenceMs(null);
      setLiveModel(null);
      setOverlayMeta(null);
    };
  }, [
    enabled,
    cameraId,
    setOverlayBoxes,
    setOverlayKnown,
    setInferenceMs,
    setLiveModel,
    setOverlayMeta,
  ]);

  useEffect(() => {
    if (!enabled || !cameraId || !overlayNonce) return undefined;
    tickRef.current();
    return undefined;
  }, [overlayNonce, enabled, cameraId]);
}
