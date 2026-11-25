import { create } from 'zustand';

/**
 * What a clicked notification points at. Waste Detections reads detectionId,
 * scrolls to that record and flashes it, then clears it.
 */
export const useFocusStore = create((set) => ({
  detectionId: null,
  focusDetection: (id) => set({ detectionId: Number(id) || null }),
  clearDetection: () => set({ detectionId: null }),
}));

/** Main Dashboard flashes the Cleanup threshold card once after this is set. */
export const FLASH_CLEANUP_KEY = 'tidalwatch-flash-cleanup';
