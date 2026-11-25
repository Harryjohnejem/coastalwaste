import { create } from 'zustand';

const MODULE_KEY = 'tidalwatch-module';
const MODULES = ['live', 'detections', 'cameras', 'reports'];
const stored = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(MODULE_KEY) : null;
// Ignore old or unknown values (e.g. "today", which is now its own page).
const savedModule = MODULES.includes(stored) ? stored : null;

/** Left-rail module: live | detections | cameras | reports */
export const useNavStore = create((set) => ({
  module: savedModule || 'live',
  setModule: (module) => {
    sessionStorage.setItem(MODULE_KEY, module);
    set({ module });
  },
}));
