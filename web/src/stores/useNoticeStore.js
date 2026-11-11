import { create } from 'zustand';

let toastSeq = 0;

const DURATION = {
  success: 3500,
  info: 4000,
  warning: 5000,
  error: 6000,
};

export const useNoticeStore = create((set, get) => ({
  toasts: [],
  dialog: null,

  pushToast(toast) {
    const id = ++toastSeq;
    const type = toast.type || 'info';
    set((s) => ({
      toasts: [...s.toasts.slice(-4), { id, type, title: toast.title, message: toast.message || '' }],
    }));
    window.setTimeout(() => get().dismissToast(id), toast.duration ?? DURATION[type] ?? 4000);
    return id;
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  ask(options) {
    return new Promise((resolve) => {
      set({
        dialog: {
          title: options.title,
          message: options.message,
          tone: options.tone || 'warning',
          confirmLabel: options.confirmLabel || 'Confirm',
          cancelLabel: options.cancelLabel || 'Cancel',
          resolve,
        },
      });
    });
  },

  settle(ok) {
    const dialog = get().dialog;
    if (!dialog) return;
    dialog.resolve(Boolean(ok));
    set({ dialog: null });
  },
}));

export const notice = {
  success: (title, message) => useNoticeStore.getState().pushToast({ type: 'success', title, message }),
  error: (title, message) => useNoticeStore.getState().pushToast({ type: 'error', title, message }),
  warning: (title, message) => useNoticeStore.getState().pushToast({ type: 'warning', title, message }),
  info: (title, message) => useNoticeStore.getState().pushToast({ type: 'info', title, message }),
  confirm: (options) => useNoticeStore.getState().ask(options),
};
