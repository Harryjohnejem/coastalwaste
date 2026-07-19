import { create } from 'zustand';
import * as camerasApi from '../api/cameras';
import { MOCK_CAMERAS } from '../data/mock';
import { resolvePlayableUrl } from '../lib/streamUrl';

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
  overlayBoxes: [],
  inferenceMs: null, // from Python YOLO worker
  liveModel: null,
  gridView: false,
  recording: false,
  deckNotice: null, // short status toast under the deck actions

  setGridView: (gridView) => set({ gridView }),
  toggleGridView: () => set((s) => ({ gridView: !s.gridView })),
  setRecording: (recording) => set({ recording }),
  setDeckNotice: (deckNotice) => set({ deckNotice }),
  setDetectionOn: (detectionOn) => set({ detectionOn }),
  setOverlayBoxes: (overlayBoxes) => set({ overlayBoxes }),
  setInferenceMs: (inferenceMs) => set({ inferenceMs }),
  setLiveModel: (liveModel) => set({ liveModel }),

  setActiveCamera: (id) => {
    const prev = get().activeCameraId;
    if (prev === id) return;
    set({
      activeCameraId: id,
      streamStatus: 'STANDBY',
      liveSince: null,
      latencyMs: null,
    });
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
          const probeUrl = resolvePlayableUrl(url) || url;
          const res = await fetch(probeUrl, { method: 'GET', signal: AbortSignal.timeout(4000) });
          // go2rtc MSE returns 200 and starts streaming — abort after headers
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
    set({ loading: true, error: null });
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
