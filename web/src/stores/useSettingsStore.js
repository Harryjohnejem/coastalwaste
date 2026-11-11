import { create } from 'zustand';
import * as settingsApi from '../api/settings';
import * as detectionsApi from '../api/detections';
import * as reportsApi from '../api/reports';
import * as quotasApi from '../api/quotas';
import * as wasteCatalogApi from '../api/wasteCatalog';
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

  chartTrends: null,
  trendsLoading: false,

  quotas: [],
  quotasLoading: false,

  wasteCatalog: [],
  wasteCatalogLoading: false,

  settingsTab: 'camera',
  openSettings: (tab) =>
    set({
      settingsOpen: true,
      settingsTab: typeof tab === 'string' ? tab : 'camera',
    }),
  closeSettings: () => set({ settingsOpen: false, settingsTab: 'camera' }),

  /** Keep a short client-side feed of YOLO log hits + Live Monitor snapshots. */
  prependLiveDetection: (row) => {
    set((s) => ({
      liveDetections: [row, ...s.liveDetections].slice(0, 80),
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
    set({ settings: next });
    try {
      await settingsApi.updateSettings(next);
      set({ settingsOpen: false, settingsError: null });
      return true;
    } catch (err) {
      set({
        settingsError: err.message || 'Could not save settings.',
        settingsOpen: false,
      });
      return false;
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
          total_detections: stats?.total_detections ?? MOCK_STATS.total_detections,
          month_detections: stats?.month_detections ?? MOCK_STATS.month_detections,
          avg_confidence: stats?.avg_confidence ?? MOCK_STATS.avg_confidence,
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

  fetchComposition: async (range = '24h') => {
    set({ compositionLoading: true });
    try {
      const composition = await detectionsApi.getComposition(range);
      const list = Array.isArray(composition) ? composition : composition?.data ?? [];
      set({ composition: list, compositionLoading: false });
    } catch {
      set({ compositionLoading: false });
    }
  },

  fetchTrends: async () => {
    set({ trendsLoading: true });
    try {
      const trends = await detectionsApi.getTrends();
      set({
        chartTrends: {
          daily: Array.isArray(trends?.daily) ? trends.daily : [],
          weekly: Array.isArray(trends?.weekly) ? trends.weekly : [],
          monthly: Array.isArray(trends?.monthly) ? trends.monthly : [],
        },
        trendsLoading: false,
      });
    } catch {
      set({ trendsLoading: false });
    }
  },

  fetchQuotas: async () => {
    try {
      const quotas = await quotasApi.listQuotas();
      const list = Array.isArray(quotas) ? quotas : quotas?.data ?? [];
      set({ quotas: list, quotasLoading: false });
    } catch {
      set({ quotasLoading: false });
    }
  },

  fetchWasteCatalog: async () => {
    set({ wasteCatalogLoading: true });
    try {
      const catalog = await wasteCatalogApi.listWasteCatalog();
      const list = Array.isArray(catalog) ? catalog : catalog?.data ?? [];
      set({ wasteCatalog: list, wasteCatalogLoading: false });
    } catch {
      set({ wasteCatalogLoading: false });
    }
  },

  addWasteCategory: async (payload) => {
    const row = await wasteCatalogApi.createWasteCategory(payload);
    await get().fetchWasteCatalog();
    return row;
  },

  addWasteClassification: async (payload) => {
    const row = await wasteCatalogApi.createWasteClassification(payload);
    await get().fetchWasteCatalog();
    return row;
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
