import { create } from 'zustand';

/** Left-rail module: live | detections | cameras | reports */
export const useNavStore = create((set) => ({
  module: 'live',
  setModule: (module) => set({ module }),
}));
