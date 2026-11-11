import { create } from 'zustand';
import { useCameraStore } from './useCameraStore';
import * as settingsApi from '../api/settings';
import * as detectionsApi from '../api/detections';
import * as reportsApi from '../api/reports';
import * as wasteCatalogApi from '../api/wasteCatalog';
import {
  MOCK_SETTINGS,
} from '../data/mock';

let detectionsRequest = null;
let detectionsRequestLimit = null;
let detectionsAbort = null;

function mergeSettings(base, incoming) {
  if (!incoming || typeof incoming !== 'object') return base;
  return {
    ...base,
    ...incoming,
    stream: { ...base.stream, ...(incoming.stream || {}) },
    detection: { ...base.detection, ...(incoming.detection || {}) },
    recording: { ...base.recording, ...(incoming.recording || {}) },
    alerts: { ...base.alerts, ...(incoming.alerts || {}) },
    station: { ...base.station, ...(incoming.station || {}) },
  };
}

export const useSettingsStore = create((set, get) => ({
  settings: MOCK_SETTINGS,
  settingsOpen: false,
  settingsLoading: false,
  settingsSaving: false,
  settingsError: null,

  stats: {
    total_detections: 0,
    detections: 0,
    month_detections: 0,
    present: 0,
    confirmed_cleaned: 0,
    confirmed_cleaned_today: 0,
    last_removed_at: null,
    reports_filed: 0,
    deltas: {},
  },
  statsReady: false,
  statsLoading: false,
  statsError: null,

  detections: [],
  liveDetections: [],
  detectionsLoading: false,
  detectionsLoaded: false,
  detectionsError: null,

  composition: [],
  compositionLoading: false,

  chartTrends: null,
  trendsLoading: false,

  wasteCatalog: [],
  wasteCatalogLoading: false,

  settingsTab: 'camera',
  openSettings: (tab) =>
    set({
      settingsOpen: true,
      settingsTab: typeof tab === 'string' ? tab : 'camera',
      settingsError: null,
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
      const merged = mergeSettings(MOCK_SETTINGS, settings);
      useCameraStore.getState().setDetectionOn(merged.detection?.enabled !== false);
      set({
        settings: merged,
        settingsLoading: false,
        settingsError: null,
      });
    } catch (err) {
      set({
        settingsLoading: false,
        settingsError: err.message || 'Could not load settings.',
      });
    }
  },

  setDetectionEnabled: async (enabled) => {
    const current = get().settings;
    const next = {
      ...current,
      detection: { ...current.detection, enabled },
    };
    set({ settings: next });
    try {
      const saved = await settingsApi.updateSettings(next);
      const merged = mergeSettings(MOCK_SETTINGS, saved);
      useCameraStore.getState().setDetectionOn(merged.detection?.enabled !== false);
      set({ settings: merged });
      return true;
    } catch (err) {
      useCameraStore.getState().setDetectionOn(!enabled);
      set({
        settings: current,
        settingsError: err?.response?.data?.message || err.message || 'Could not change detection.',
      });
      return false;
    }
  },

  saveSettings: async (next) => {
    set({ settingsSaving: true, settingsError: null });
    try {
      const saved = await settingsApi.updateSettings(next);
      set({
        settings: mergeSettings(MOCK_SETTINGS, saved),
        settingsSaving: false,
        settingsError: null,
        settingsOpen: false,
      });
      return true;
    } catch (err) {
      set({
        settingsSaving: false,
        settingsError:
          err?.response?.data?.message || err.message || 'Could not save settings.',
      });
      return false;
    }
  },

  fetchStats: async () => {
    const hasStats = get().statsReady;
    if (!hasStats) set({ statsLoading: true, statsError: null });
    try {
      const stats = await detectionsApi.getTodayStats();
      set({
        stats: {
          ...stats,
          present: stats?.present ?? 0,
          confirmed_cleaned: stats?.confirmed_cleaned ?? 0,
          confirmed_cleaned_today: stats?.confirmed_cleaned_today ?? 0,
          last_removed_at: stats?.last_removed_at ?? null,
          total_detections: stats?.total_detections ?? 0,
          month_detections: stats?.month_detections ?? 0,
          detections: stats?.detections ?? 0,
          deltas: stats?.deltas || {},
        },
        statsReady: true,
        statsLoading: false,
      });
    } catch (err) {
      set({
        statsReady: true,
        statsLoading: false,
        statsError: err.message || 'Could not load today\'s stats.',
      });
    }
  },

  fetchDetections: async (limit = 50) => {
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
    if (detectionsRequest && detectionsRequestLimit === cap) return detectionsRequest;
    if (detectionsAbort) detectionsAbort.abort();
    const controller = new AbortController();
    detectionsAbort = controller;
    set((state) => ({
      detectionsLoading: state.detections.length === 0,
      detectionsError: null,
    }));
    detectionsRequestLimit = cap;
    detectionsRequest = (async () => {
      try {
        const detections = await detectionsApi.listDetections(cap, {}, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const list = Array.isArray(detections) ? detections : detections?.data ?? [];
        const previous = get().detections;
        const unchanged = previous.length === list.length
          && previous.every((row, index) => (
            row?.id === list[index]?.id
            && row?.status === list[index]?.status
            && row?.last_seen_at === list[index]?.last_seen_at
          ));
        if (unchanged) {
          set({ detectionsLoading: false, detectionsLoaded: true, detectionsError: null });
          return;
        }
        set({ detections: list, detectionsLoading: false, detectionsLoaded: true, detectionsError: null });
      } catch (err) {
        if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError' || controller.signal.aborted) {
          return;
        }
        set({
          detectionsLoading: false,
          detectionsLoaded: true,
          detectionsError: get().detections.length
            ? null
            : 'Unable to load detection records.',
        });
      } finally {
        if (detectionsAbort === controller) {
          detectionsAbort = null;
          detectionsRequest = null;
          detectionsRequestLimit = null;
        }
      }
    })();
    return detectionsRequest;
  },

  fetchComposition: async (range = '24h') => {
    if (!get().composition.length) set({ compositionLoading: true });
    try {
      const composition = await detectionsApi.getComposition(range);
      const list = Array.isArray(composition) ? composition : composition?.data ?? [];
      set({ composition: list, compositionLoading: false });
    } catch {
      set({ compositionLoading: false });
    }
  },

  fetchTrends: async () => {
    if (!get().chartTrends) set({ trendsLoading: true });
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
