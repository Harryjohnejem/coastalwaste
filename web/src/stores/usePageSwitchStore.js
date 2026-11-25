import { create } from 'zustand';

/** How long the loading screen shows when switching pages. */
export const PAGE_SWITCH_MS = 2500;

/**
 * Switching between the main dashboard and Today's Report shows a short
 * loading screen first. PageSwitchOverlay does the navigation.
 */
export const usePageSwitchStore = create((set, get) => ({
  pending: null,
  /** to: route path; label: text under the spinner; module: dashboard module to open. */
  start: (to, label, module) => {
    if (get().pending) return;
    set({ pending: { to, label, module } });
  },
  clear: () => set({ pending: null }),
}));
