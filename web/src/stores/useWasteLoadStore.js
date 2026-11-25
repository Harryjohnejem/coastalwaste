import { create } from 'zustand';
import { getWasteLoad } from '../api/wasteLoad';
import { notice } from './useNoticeStore';

const RANK = { normal: 0, warning: 1, full: 2 };

/**
 * Cleanup threshold for the alert banner. The main dashboard polls it; Today's
 * Report hands over the copy that comes with each report (no extra request).
 * When a camera climbs to a higher level a toast pops up once.
 */
export const useWasteLoadStore = create((set, get) => ({
  load: null,
  hiddenKey: null,
  running: false,

  /** Take a fresh waste-load result and toast any camera that went up a level. */
  apply: (next) => {
    if (!next) return;
    const prev = get().load;
    if (prev && next.enabled) {
      const before = Object.fromEntries((prev.cameras || []).map((c) => [c.code, c.level]));
      (next.cameras || []).forEach((c) => {
        if (RANK[c.level] <= RANK[before[c.code] || 'normal']) return;
        if (c.level === 'full') {
          notice.error(`Cleanup needed · ${c.code}`, `${c.count} of ${next.limit} items on the beach. Send a cleanup team.`);
        } else if (c.level === 'warning') {
          notice.warning(`Waste building up · ${c.code}`, `${c.percent}% of the cleanup limit (${c.count} of ${next.limit}).`);
        }
      });
    }
    set({ load: next });
  },

  refresh: async () => {
    if (get().running) return;
    set({ running: true });
    try {
      get().apply(await getWasteLoad());
    } catch {
      // Keep the last known load; the next poll tries again.
    } finally {
      set({ running: false });
    }
  },

  /** Hide the banner until any camera changes level. */
  hide: () => set({ hiddenKey: bannerKey(get().load) }),
}));

export function bannerKey(load) {
  return (load?.cameras || []).map((c) => `${c.code}:${c.level}`).join('|');
}
