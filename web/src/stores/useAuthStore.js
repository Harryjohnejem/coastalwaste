import { create } from 'zustand';
import { AUTH_STORAGE_KEY } from '../constants';

function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return { token: null, user: null };
    return JSON.parse(raw);
  } catch {
    return { token: null, user: null };
  }
}

function persistAuth(token, user) {
  try {
    if (!token) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      return;
    }
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token, user }));
  } catch {
    /* ignore */
  }
}

const initial = loadAuth();

export const useAuthStore = create((set) => ({
  token: initial.token,
  user: initial.user,
  setAuth: (token, user) => {
    persistAuth(token, user);
    set({ token, user });
  },
  logout: () => {
    persistAuth(null, null);
    set({ token: null, user: null });
  },
  isAuthenticated: () => Boolean(useAuthStore.getState().token),
}));
