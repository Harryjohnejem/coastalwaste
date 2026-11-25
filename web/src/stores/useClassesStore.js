import { create } from 'zustand';
import client from '../api/client';
import {
  CATEGORY_BY_CLASS,
  LIVE_DETECTION_CLASSES,
  LIVE_EXCLUDED_CLASSES,
  PARENT_CATEGORIES,
  WASTE_CLASSES,
} from '../constants';

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function replaceContents(target, values) {
  target.splice(0, target.length, ...values);
}

/**
 * Bring the shared class lists up to date with the server (GET /api/classes):
 * classes of the deployed model and of the waste catalog, and new categories.
 * The lists in constants.js are updated in place, so every screen and the
 * report form read the same, current lists.
 */
export function applyClasses(payload) {
  if (!payload || !Array.isArray(payload.all)) return;
  for (const name of payload.all) {
    if (!WASTE_CLASSES.some((known) => sameName(known, name))) WASTE_CLASSES.push(name);
  }
  if (payload.category_of && typeof payload.category_of === 'object') {
    for (const [name, category] of Object.entries(payload.category_of)) {
      const known = Object.keys(CATEGORY_BY_CLASS).find((key) => sameName(key, name));
      if (!known) CATEGORY_BY_CLASS[name] = category;
    }
  }
  if (Array.isArray(payload.categories) && payload.categories.length) {
    replaceContents(PARENT_CATEGORIES, payload.categories);
  }
  if (Array.isArray(payload.live) && payload.live.length) {
    replaceContents(
      LIVE_DETECTION_CLASSES,
      payload.live.filter((name) => !LIVE_EXCLUDED_CLASSES.some((ex) => sameName(ex, name))),
    );
  }
}

/** version goes up after each refresh, so screens that list classes re-render. */
export const useClassesStore = create((set, get) => ({
  version: 0,
  loading: false,
  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const { data } = await client.get('/classes', { timeout: 15000 });
      applyClasses(data);
      set((s) => ({ version: s.version + 1 }));
    } catch {
      // Keep the built-in lists; the next load tries again.
    } finally {
      set({ loading: false });
    }
  },
}));
