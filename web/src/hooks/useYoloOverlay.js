import { useEffect, useRef } from 'react';
import * as detectionsApi from '../api/detections';
import { useCameraStore } from '../stores/useCameraStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { OVERLAY_POLL_MS } from '../constants';

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
 * Poll YOLO live boxes for the HUD overlay + Detection Log.
 */
export function useYoloOverlay({ enabled, cameraId }) {
  const setOverlayBoxes = useCameraStore((s) => s.setOverlayBoxes);
  const setInferenceMs = useCameraStore((s) => s.setInferenceMs);
  const setLiveModel = useCameraStore((s) => s.setLiveModel);
  const prependLiveDetection = useSettingsStore((s) => s.prependLiveDetection);
  const lastLoggedRef = useRef({});

  useEffect(() => {
    if (!enabled || !cameraId) {
      setOverlayBoxes([]);
      setInferenceMs(null);
      setLiveModel(null);
      return undefined;
    }

    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await fetchOverlay(cameraId);
        if (cancelled) return;
        const boxes = Array.isArray(data?.boxes) ? data.boxes : [];
        setOverlayBoxes(boxes);
        setInferenceMs(data?.inference_ms ?? null);
        setLiveModel(data?.model ?? null);

        if (!boxes.length) return;

        const now = Date.now();
        const byClass = new Map();
        for (const b of boxes) {
          const key = (b.class || 'object').toLowerCase();
          const prev = byClass.get(key);
          const conf = Number(b.confidence) || 0;
          if (!prev) {
            byClass.set(key, {
              class: b.class,
              confidence: conf,
              severity: b.severity || 'alert',
              count: 1,
            });
          } else {
            prev.count += 1;
            prev.confidence = Math.max(prev.confidence, conf);
          }
        }

        for (const row of byClass.values()) {
          const key = String(row.class).toLowerCase();
          const prevAt = lastLoggedRef.current[key] || 0;
          if (now - prevAt < 8000) continue;
          lastLoggedRef.current[key] = now;
          prependLiveDetection({
            id: `live-${key}-${now}`,
            camera_id: cameraId,
            class: row.class,
            confidence: row.confidence,
            count: row.count,
            severity: row.severity,
            detected_at: (() => {
              const dt = new Date();
              const p = (n) => String(n).padStart(2, '0');
              return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
            })(),
            subtitle: `${row.count} object${row.count !== 1 ? 's' : ''} · YOLO · ${cameraId}`,
          });
        }
      } catch {
        /* offline */
      } finally {
        inFlight = false;
      }
    };

    tick();
    const id = setInterval(tick, OVERLAY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      setOverlayBoxes([]);
      setInferenceMs(null);
      setLiveModel(null);
    };
  }, [
    enabled,
    cameraId,
    setOverlayBoxes,
    setInferenceMs,
    setLiveModel,
    prependLiveDetection,
  ]);
}
