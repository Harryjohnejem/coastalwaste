import { create } from 'zustand';
import { AUTH_STORAGE_KEY } from '../constants';

/*
 * "Remember me" on: the sign-in is kept in localStorage and survives closing
 * the browser. Off: it is kept in sessionStorage only, so a page refresh stays
 * signed in but a new browser session shows the login form again.
 */

function read(storage) {
  try {
    const raw = storage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function remove(storage) {
  try {
    storage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function loadAuth() {
  const remembered = read(localStorage);
  if (remembered?.token && remembered.remember === true) {
    return { token: remembered.token, user: remembered.user ?? null };
  }
  // Older versions saved every sign-in here, even without "Remember me".
  if (remembered) remove(localStorage);
  const session = read(sessionStorage);
  if (session?.token) {
    return { token: session.token, user: session.user ?? null };
  }
  return { token: null, user: null };
}

function persistAuth(token, user, remember) {
  remove(localStorage);
  remove(sessionStorage);
  if (!token) return;
  try {
    const storage = remember ? localStorage : sessionStorage;
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token, user, remember: Boolean(remember) }));
  } catch {
    /* ignore */
  }
}

function isRemembered() {
  return read(localStorage)?.remember === true;
}

const initial = loadAuth();

export const useAuthStore = create((set) => ({
  token: initial.token,
  user: initial.user,
  /** remember: keep the sign-in after the browser closes. Omitted: keep the current choice. */
  setAuth: (token, user, remember) => {
    persistAuth(token, user, remember === undefined ? isRemembered() : remember);
    set({ token, user });
  },
  logout: () => {
    persistAuth(null, null, false);
    // The saved Today's Report belongs to the signed-in admin.
    try {
      localStorage.removeItem('tidalwatch-today-report');
    } catch {
      /* storage blocked */
    }
    set({ token: null, user: null });
  },
  isAuthenticated: () => Boolean(useAuthStore.getState().token),
}));
