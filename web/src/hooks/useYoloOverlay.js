import { useEffect } from 'react';
import * as detectionsApi from '../api/detections';
import { useCameraStore } from '../stores/useCameraStore';
import { OVERLAY_POLL_MS } from '../constants';

/**
 * Poll Laravel for YOLO-World live boxes posted by the Python detector.
 */
export function useYoloOverlay({ enabled, cameraId }) {
  const setOverlayBoxes = useCameraStore((s) => s.setOverlayBoxes);
  const setInferenceMs = useCameraStore((s) => s.setInferenceMs);
  const setLiveModel = useCameraStore((s) => s.setLiveModel);

  useEffect(() => {
    if (!enabled || !cameraId) {
      setOverlayBoxes([]);
      setInferenceMs(null);
      setLiveModel(null);
      return undefined;
    }

    let cancelled = false;

    const tick = async () => {
      try {
        const data = await detectionsApi.getLiveOverlay(cameraId);
        if (cancelled) return;
        setOverlayBoxes(Array.isArray(data?.boxes) ? data.boxes : []);
        setInferenceMs(data?.inference_ms ?? null);
        setLiveModel(data?.model ?? null);
      } catch {
        /* detector / API offline */
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
  }, [enabled, cameraId, setOverlayBoxes, setInferenceMs, setLiveModel]);
}
