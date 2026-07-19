import { create } from 'zustand';
import * as settingsApi from '../api/settings';
import * as detectionsApi from '../api/detections';
import * as reportsApi from '../api/reports';
import {
  MOCK_SETTINGS,
  MOCK_STATS,
  MOCK_DETECTIONS,
  MOCK_COMPOSITION,
} from '../data/mock';

export const useSettingsStore = create((set, get) => ({
  settings: MOCK_SETTINGS,
  settingsOpen: false,
  settingsLoading: false,
  settingsError: null,

  stats: MOCK_STATS,
  statsLoading: false,
  statsError: null,

  detections: MOCK_DETECTIONS,
  liveDetections: [],
  detectionsLoading: false,
  detectionsError: null,

  composition: MOCK_COMPOSITION,
  compositionLoading: false,

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  /** Keep a short client-side feed of YOLO log hits (API also persists them). */
  prependLiveDetection: (row) => {
    set((s) => ({
      liveDetections: [row, ...s.liveDetections].slice(0, 40),
    }));
  },

  fetchSettings: async () => {
    set({ settingsLoading: true, settingsError: null });
    try {
      const settings = await settingsApi.getSettings();
      set({ settings: { ...MOCK_SETTINGS, ...settings }, settingsLoading: false });
    } catch (err) {
      set({
        settingsLoading: false,
        settingsError: err.message || 'Could not load settings.',
      });
    }
  },

  saveSettings: async (next) => {
    // TODO: POST config to your backend / persist to your store
    set({ settings: next });
    try {
      await settingsApi.updateSettings(next);
      set({ settingsOpen: false });
    } catch (err) {
      set({
        settingsError: err.message || 'Could not save settings.',
        settingsOpen: false,
      });
    }
  },

  fetchStats: async () => {
    const hasStats = get().stats != null;
    // Only show loading chrome on the first paint — polling must not swap to skeletons
    // or the KPI cards keep resizing on refresh/interval.
    if (!hasStats) set({ statsLoading: true, statsError: null });
    else set({ statsError: null });
    try {
      const stats = await detectionsApi.getTodayStats();
      set({
        stats: {
          ...MOCK_STATS,
          ...stats,
          deltas: { ...MOCK_STATS.deltas, ...(stats?.deltas || {}) },
          hotspots:
            stats?.hotspots != null
              ? { ...MOCK_STATS.hotspots, ...(typeof stats.hotspots === 'object' ? stats.hotspots : {}) }
              : MOCK_STATS.hotspots,
        },
        statsLoading: false,
      });
    } catch (err) {
      set({
        statsLoading: false,
        statsError: err.message || 'Could not load today\'s stats.',
      });
    }
  },

  fetchDetections: async () => {
    set({ detectionsLoading: true, detectionsError: null });
    try {
      const detections = await detectionsApi.listDetections(50);
      const list = Array.isArray(detections) ? detections : detections?.data ?? [];
      set({ detections: list, detectionsLoading: false });
    } catch (err) {
      set({
        detectionsLoading: false,
        detectionsError: err.message || 'Could not load detection log.',
      });
    }
  },

  fetchComposition: async () => {
    set({ compositionLoading: true });
    try {
      const composition = await detectionsApi.getComposition('24h');
      const list = Array.isArray(composition) ? composition : composition?.data ?? [];
      set({ composition: list, compositionLoading: false });
    } catch {
      set({ compositionLoading: false });
    }
  },

  fileReport: async (payload = {}) => {
    // TODO: open cleanup report form
    return reportsApi.createReport(payload);
  },

  /** Kick off polling for detections + today's stats. */
  startPolling: () => {
    const { fetchDetections, fetchStats } = get();
    fetchDetections();
    fetchStats();
    // TODO: replace polling with Laravel WebSockets/Reverb or Pusher
  },
}));
