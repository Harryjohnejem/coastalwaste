import { create } from 'zustand';

const MODULE_KEY = 'tidalwatch-module';
const savedModule = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(MODULE_KEY) : null;

/** Left-rail module: live | detections | cameras | reports */
export const useNavStore = create((set) => ({
  module: savedModule || 'live',
  setModule: (module) => {
    sessionStorage.setItem(MODULE_KEY, module);
    set({ module });
  },
}));
