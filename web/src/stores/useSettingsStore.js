import { create } from 'zustand';
import { useCameraStore } from './useCameraStore';
import * as settingsApi from '../api/settings';
import * as detectionsApi from '../api/detections';
import * as reportsApi from '../api/reports';
import * as wasteCatalogApi from '../api/wasteCatalog';
import { readDetectionChoice, writeDetectionChoice } from '../lib/detectionChoice';
import {
  MOCK_SETTINGS,
} from '../data/mock';
import { useClassesStore } from './useClassesStore';

let detectionsRequest = null;
let detectionsRequestLimit = null;
let detectionsAbort = null;
let reportRequest = null;

let settingsRetryTimer = null;

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
    no_longer_visible: 0,
    no_longer_visible_today: 0,
    cleaning_verified: 0,
    cleaning_verified_today: 0,
    last_removed_at: null,
    reports_filed: 0,
    deltas: {},
  },
  statsReady: false,
  statsLoading: false,
  statsError: null,

  detections: [],
  /** Reports & Analytics records; separate so Live/Waste Detections (50 rows) never replace them. */
  reportDetections: [],
  reportDetectionsLoaded: false,
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
    clearTimeout(settingsRetryTimer);
    try {
      const settings = await settingsApi.getSettings();
      const merged = mergeSettings(MOCK_SETTINGS, settings);
      const serverOn = merged.detection?.enabled === true;
      const choice = readDetectionChoice();
      set({
        settings: merged,
        settingsLoading: false,
        settingsError: null,
      });
      if (choice?.pending && choice.value !== serverOn) {
        // The page was refreshed before the last On/Off reached Laravel.
        // Keep what the user chose and send it again.
        get().setDetectionEnabled(choice.value);
        return;
      }
      writeDetectionChoice(serverOn, false);
      useCameraStore.getState().setDetectionOn(serverOn);
    } catch (err) {
      // Keep the last known On/Off (set at startup) and try again shortly
      // instead of leaving detection off because the API was busy.
      set({
        settingsLoading: false,
        settingsError: err.message || 'Could not load settings.',
      });
      settingsRetryTimer = setTimeout(() => get().fetchSettings(), 3000);
    }
  },

  setDetectionEnabled: async (enabled) => {
    const current = get().settings;
    const previousEnabled = useCameraStore.getState().detectionOn;
    const next = {
      ...current,
      detection: { ...current.detection, enabled: Boolean(enabled) },
    };
    set({ settings: next, settingsError: null });
    useCameraStore.getState().setDetectionOn(Boolean(enabled));
    writeDetectionChoice(enabled, true);
    // Tell the detector first so On/Off applies at once. Laravel runs one
    // request at a time on Windows, so the save below can lag by seconds.
    const detectorPing = settingsApi.pingDetectorEnabled(enabled);
    try {
      // Send only the On/Off flag so a stale copy of other settings is never written back.
      const saved = await settingsApi.updateSettings({ detection: { enabled: Boolean(enabled) } });
      const merged = mergeSettings(MOCK_SETTINGS, saved);
      if (get().settings?.detection?.enabled === Boolean(enabled)) {
        const savedOn = merged.detection?.enabled === true;
        writeDetectionChoice(savedOn, false);
        useCameraStore.getState().setDetectionOn(savedOn);
        set({ settings: merged, settingsError: null });
      }
      await detectorPing;
      return true;
    } catch (err) {
      await detectorPing;
      if (get().settings?.detection?.enabled === Boolean(enabled)) {
        writeDetectionChoice(previousEnabled, false);
        set({
          settings: { ...current, detection: { ...current.detection, enabled: previousEnabled } },
          settingsError: err?.response?.data?.message || err.message || 'Could not save detection to the API.',
        });
        useCameraStore.getState().setDetectionOn(previousEnabled);
        await settingsApi.pingDetectorEnabled(previousEnabled);
      }
      return false;
    }
  },

  saveSettings: async (next) => {
    set({ settingsSaving: true, settingsError: null });
    try {
      // The Detection button owns On/Off. The settings form may hold an older
      // value from when it was opened, so always send the current one.
      const detectionOn = useCameraStore.getState().detectionOn;
      const saved = await settingsApi.updateSettings({
        ...next,
        detection: { ...(next?.detection || {}), enabled: detectionOn },
      });
      const merged = mergeSettings(MOCK_SETTINGS, saved);
      useCameraStore.getState().setDetectionOn(merged.detection?.enabled !== false);
      set({
        settings: merged,
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
          no_longer_visible: stats?.no_longer_visible ?? 0,
          no_longer_visible_today: stats?.no_longer_visible_today ?? 0,
          cleaning_verified: stats?.cleaning_verified ?? 0,
          cleaning_verified_today: stats?.cleaning_verified_today ?? 0,
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

  cancelDetectionsFetch: () => {
    const controller = detectionsAbort;
    detectionsAbort = null;
    detectionsRequest = null;
    detectionsRequestLimit = null;
    controller?.abort();
  },

  fetchReportDetections: async () => {
    if (reportRequest) return reportRequest;
    reportRequest = (async () => {
      try {
        // Every record (not only the newest 1000), so report totals stay complete.
        const list = await reportsApi.getReportRecords();
        const previous = get().reportDetections;
        const unchanged = previous.length === list.length
          && previous.every((row, index) => (
            row?.id === list[index]?.id
            && row?.status === list[index]?.status
            && row?.last_seen_at === list[index]?.last_seen_at
          ));
        set(unchanged ? { reportDetectionsLoaded: true } : { reportDetections: list, reportDetectionsLoaded: true });
      } catch {
        set({ reportDetectionsLoaded: true });
      } finally {
        reportRequest = null;
      }
    })();
    return reportRequest;
  },

  fetchDetections: async (limit = 50, options = {}) => {
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 1000);
    const perClass = options.perClass === true;
    const requestKey = `${perClass ? 'class' : 'all'}:${cap}`;
    if (detectionsRequest && detectionsRequestLimit === requestKey) return detectionsRequest;
    if (detectionsAbort) detectionsAbort.abort();
    const controller = new AbortController();
    detectionsAbort = controller;
    set((state) => ({
      detectionsLoading: state.detections.length === 0,
      detectionsError: null,
    }));
    detectionsRequestLimit = requestKey;
    detectionsRequest = (async () => {
      try {
        const detections = await detectionsApi.listDetections(
          cap,
          perClass ? { per_class: 1 } : {},
          { signal: controller.signal },
        );
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
      return list;
    } catch {
      set({ wasteCatalogLoading: false });
      return get().wasteCatalog;
    }
  },

  addWasteCategory: async (payload) => {
    const row = await wasteCatalogApi.createWasteCategory(payload);
    // New category: refresh the shared class lists (filters, report form).
    useClassesStore.getState().load();
    const saved = {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      classifications: row.classifications || [],
    };
    const merge = (list) => {
      const rows = Array.isArray(list) ? list.filter((item) => item.id !== saved.id) : [];
      rows.push(saved);
      return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    };
    set({ wasteCatalog: merge(get().wasteCatalog) });
    const fresh = await get().fetchWasteCatalog();
    set({ wasteCatalog: merge(fresh) });
    return row;
  },

  addWasteClassification: async (payload) => {
    const row = await wasteCatalogApi.createWasteClassification(payload);
    // New classification: refresh the shared class lists (filters, report form).
    useClassesStore.getState().load();
    const saved = {
      id: row.id,
      name: row.name,
      category_id: row.category_id,
    };
    const merge = (list) => {
      const rows = (Array.isArray(list) ? list : []).map((category) => ({
        ...category,
        classifications: [...(category.classifications || [])],
      }));
      let category = rows.find((item) => Number(item.id) === Number(saved.category_id));
      if (!category) {
        category = {
          id: saved.category_id,
          name: row.category || 'Category',
          description: null,
          classifications: [],
        };
        rows.push(category);
      }
      if (!category.classifications.some((item) => item.id === saved.id || item.name === saved.name)) {
        category.classifications.push(saved);
        category.classifications.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }
      return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    };
    set({ wasteCatalog: merge(get().wasteCatalog) });
    const fresh = await get().fetchWasteCatalog();
    set({ wasteCatalog: merge(fresh) });
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
