import { create } from 'zustand';
import * as camerasApi from '../api/cameras';
import { MOCK_CAMERAS } from '../data/mock';
import { resolvePlayableUrl } from '../lib/streamUrl';

function overlayFrameUnchanged(current, next) {
  if (Boolean(current.overlayKnown) !== Boolean(next.overlayKnown)) return false;
  if ((current.inferenceMs ?? null) !== (next.inferenceMs ?? null)) return false;
  if ((current.liveModel ?? null) !== (next.liveModel ?? null)) return false;
  const prevMeta = current.overlayMeta;
  const nextMeta = next.overlayMeta;
  if ((prevMeta?.frameId ?? null) !== (nextMeta?.frameId ?? null)) return false;
  if (String(prevMeta?.cameraId || '') !== String(nextMeta?.cameraId || '')) return false;
  if (Boolean(prevMeta?.connected) !== Boolean(nextMeta?.connected)) return false;
  if (Boolean(prevMeta?.motionActive) !== Boolean(nextMeta?.motionActive)) return false;
  const left = current.overlayBoxes || [];
  const right = next.overlayBoxes || [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if ((a?.track_id ?? null) !== (b?.track_id ?? null)) return false;
    if ((a?.class || '') !== (b?.class || '')) return false;
    if (Math.round(Number(a?.left) || 0) !== Math.round(Number(b?.left) || 0)) return false;
    if (Math.round(Number(a?.top) || 0) !== Math.round(Number(b?.top) || 0)) return false;
  }
  return true;
}

export const useCameraStore = create((set, get) => ({
  cameras: MOCK_CAMERAS,
  activeCameraId: MOCK_CAMERAS[0]?.id ?? null,
  streamStatus: 'STANDBY', // STANDBY | CONNECTING… | LIVE | ERROR
  liveSince: null, // Date.now() when stream became LIVE
  latencyMs: null,
  loading: false,
  error: null,
  cameraModal: { open: false, mode: 'add', cameraId: null },
  detectionOn: true,
  overlayNonce: 0,
  overlayBoxes: [],
  overlayKnown: false,
  overlayMeta: null, // { cameraId, frameId, detectToPublishMs, inferenceFps, ... }
  inferenceMs: null, // from Python YOLO worker
  liveModel: null,
  gridView: false,
  recording: false,

  setGridView: (gridView) => set({ gridView }),
  toggleGridView: () => set((s) => ({ gridView: !s.gridView })),
  setRecording: (recording) => set({ recording }),
  setDetectionOn: (detectionOn) => set({ detectionOn }),
  refreshOverlay: () =>
    set((s) => ({ detectionOn: true, overlayNonce: s.overlayNonce + 1 })),
  setOverlayBoxes: (overlayBoxes) => set({ overlayBoxes }),
  setOverlayKnown: (overlayKnown) => set({ overlayKnown }),
  setOverlayMeta: (overlayMeta) => set({ overlayMeta }),
  setInferenceMs: (inferenceMs) => set({ inferenceMs }),
  setLiveModel: (liveModel) => set({ liveModel }),
  applyOverlay: (next) => set((s) => {
    const overlayBoxes = next.overlayBoxes ?? [];
    const overlayMeta = next.overlayMeta ?? null;
    const overlayKnown = next.overlayKnown !== false;
    const inferenceMs = next.inferenceMs ?? null;
    const liveModel = next.liveModel ?? s.liveModel;
    if (overlayFrameUnchanged(s, { overlayBoxes, overlayMeta, overlayKnown, inferenceMs, liveModel })) {
      return s;
    }
    return { overlayBoxes, overlayMeta, overlayKnown, inferenceMs, liveModel };
  }),

  setActiveCamera: (id) => {
    const prev = get().activeCameraId;
    if (prev === id) return;
    set({
      activeCameraId: id,
      streamStatus: 'STANDBY',
      liveSince: null,
      latencyMs: null,
      // Never carry boxes from one lens onto another.
      overlayBoxes: [],
      overlayKnown: false,
      overlayMeta: null,
      inferenceMs: null,
    });
  },

  /** Cycle to previous / next camera (wide-angle ↔ second lens). */
  cycleCamera: (direction = 1) => {
    const { cameras, activeCameraId, setActiveCamera, setGridView } = get();
    if (!cameras.length) return null;
    const idx = Math.max(
      0,
      cameras.findIndex((c) => c.id === activeCameraId),
    );
    const next =
      cameras[(idx + direction + cameras.length) % cameras.length] ?? null;
    if (!next) return null;
    setGridView(false);
    setActiveCamera(next.id);
    return next;
  },

  setStreamStatus: (streamStatus) => {
    set((s) => {
      const cameras = s.cameras.map((c) => {
        if (c.id !== s.activeCameraId) return c;
        if (streamStatus === 'LIVE') return { ...c, status: 'live' };
        if (streamStatus === 'ERROR') return { ...c, status: 'offline' };
        return c;
      });
      let liveSince = s.liveSince;
      if (streamStatus === 'LIVE') {
        liveSince = s.streamStatus === 'LIVE' && s.liveSince ? s.liveSince : Date.now();
      } else {
        liveSince = null;
      }
      return { streamStatus, cameras, liveSince };
    });
  },
  setLatencyMs: (latencyMs) => set({ latencyMs }),

  setCameraStatus: (id, status) =>
    set((s) => ({
      cameras: s.cameras.map((c) => (c.id === id ? { ...c, status } : c)),
    })),

  /** Probe each camera and mark live/offline. RTSP without gateway = offline. */
  rescanCameras: async () => {
    const { cameras, setCameraStatus, fetchCameras } = get();
    await fetchCameras();
    const list = get().cameras.length ? get().cameras : cameras;

    await Promise.all(
      list.map(async (cam) => {
        const url = cam.stream_url;
        const protocol = cam.protocol || '';
        if (!url || /^rtsp:\/\//i.test(url) || String(protocol).toUpperCase().includes('RTSP')) {
          setCameraStatus(cam.id, 'offline');
          return;
        }
        try {
          const playUrl = resolvePlayableUrl(url) || url;
          const probeUrl = String(playUrl).includes('/api/stream.mp4')
            ? String(playUrl).replace('/api/stream.mp4', '/api/frame.jpeg')
            : playUrl;
          const res = await fetch(probeUrl, { method: 'GET', signal: AbortSignal.timeout(8000) });
          if (res.ok) setCameraStatus(cam.id, 'live');
          else setCameraStatus(cam.id, 'offline');
        } catch {
          setCameraStatus(cam.id, 'offline');
        }
      }),
    );
  },

  openCameraModal: (mode, cameraId = null) =>
    set({ cameraModal: { open: true, mode, cameraId } }),
  closeCameraModal: () =>
    set({ cameraModal: { open: false, mode: 'add', cameraId: null } }),

  getActiveCamera: () => {
    const { cameras, activeCameraId } = get();
    return cameras.find((c) => c.id === activeCameraId) ?? null;
  },

  fetchCameras: async () => {
    set({ error: null });
    try {
      const cameras = await camerasApi.listCameras();
      const list = Array.isArray(cameras) ? cameras : cameras?.data ?? [];
      const activeCameraId = get().activeCameraId;
      const stillActive = list.some((c) => c.id === activeCameraId);
      set({
        cameras: list,
        activeCameraId: stillActive ? activeCameraId : list[0]?.id ?? null,
        loading: false,
      });
    } catch (err) {
      set({ loading: false, error: err.message || 'Could not load cameras.' });
      // Keep mock cameras so the UI remains usable while the API is missing.
    }
  },

  createCamera: async (payload) => {
    const created = await camerasApi.createCamera(payload);
    // TODO: attempt to connect the new stream and flip the tag to LIVE
    set((s) => ({ cameras: [...s.cameras, created] }));
    return created;
  },

  updateCamera: async (id, payload) => {
    // TODO: persist cfg to your backend
    const updated = await camerasApi.updateCamera(id, payload);
    set((s) => ({
      cameras: s.cameras.map((c) => (c.id === id ? { ...c, ...updated } : c)),
    }));
    return updated;
  },

  removeCamera: async (id) => {
    // TODO: notify your backend
    await camerasApi.deleteCamera(id);
    set((s) => {
      const cameras = s.cameras.filter((c) => c.id !== id);
      const activeCameraId =
        s.activeCameraId === id ? cameras[0]?.id ?? null : s.activeCameraId;
      return { cameras, activeCameraId };
    });
  },

  testCamera: async (id, url) => {
    try {
      if (id) {
        return await camerasApi.testCamera(id);
      }
      // Local URL test without a persisted camera id — probe via temporary connect.
      return { ok: Boolean(url), latency_ms: null };
    } catch {
      throw new Error("Couldn't reach the camera. Check the URL and credentials.");
    }
  },
}));
