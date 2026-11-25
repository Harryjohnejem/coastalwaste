import { create } from 'zustand';
import { getTodayReport } from '../api/reports';
import { useWasteLoadStore } from './useWasteLoadStore';

const SAVED_KEY = 'tidalwatch-today-report';

/** The last report from today, so a refresh opens with numbers instead of "Loading…". */
function readSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || 'null');
    if (!saved?.generated_at) return null;
    const sameDay = new Date(saved.generated_at).toDateString() === new Date().toDateString();
    return sameDay ? saved : null;
  } catch {
    return null;
  }
}

function writeSaved(report) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(report));
  } catch {
    // Storage full or blocked: the page still works, it just waits on refresh.
  }
}

/**
 * Keeps the last Today's Report so the page opens with numbers right away.
 * The page-switch screen calls prefetch() while it is showing. Each report
 * also carries the cleanup threshold, which feeds the alert banner.
 */
export const useTodayReportStore = create((set) => ({
  report: readSaved(),
  setReport: (report) => {
    if (!report) return;
    writeSaved(report);
    if (report.waste_load) useWasteLoadStore.getState().apply(report.waste_load);
    set({ report });
  },
  prefetch: async () => {
    try {
      useTodayReportStore.getState().setReport(await getTodayReport());
    } catch {
      /* the page retries on its own */
    }
  },
}));
