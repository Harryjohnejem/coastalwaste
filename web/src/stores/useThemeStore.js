import { create } from 'zustand';
import { THEME_STORAGE_KEY } from '../constants';

function getInitialTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

function applyDomTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

const initial = getInitialTheme();
if (typeof document !== 'undefined') {
  applyDomTheme(initial);
}

export const useThemeStore = create((set, get) => ({
  theme: initial,
  setTheme: (theme) => {
    applyDomTheme(theme);
    set({ theme });
  },
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    applyDomTheme(next);
    set({ theme: next });
  },
}));
