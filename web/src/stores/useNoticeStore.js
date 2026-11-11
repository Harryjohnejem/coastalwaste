import { create } from 'zustand';

let toastSeq = 0;

function defaultTitle(type) {
  if (type === 'success') return 'Success';
  if (type === 'warning') return 'Warning';
  if (type === 'error') return 'Error';
  return 'Notice';
}

export function actionErrorMessage(err, fallback = 'The action could not be completed.') {
  const data = err?.response?.data;
  if (typeof data?.message === 'string' && data.message) return data.message;
  const first = data?.errors && Object.values(data.errors).flat()[0];
  if (first) return String(first);
  if (typeof err?.message === 'string' && err.message) return err.message;
  return fallback;
}

export const useNoticeStore = create((set, get) => ({
  toasts: [],
  confirming: null,

  push: ({ type = 'info', title, message, duration }) => {
    const id = ++toastSeq;
    const kind = ['success', 'warning', 'error', 'info'].includes(type) ? type : 'info';
    const hold = duration ?? (kind === 'error' ? 5600 : 4200);
    const toast = {
      id,
      type: kind,
      title: title || defaultTitle(kind),
      message: String(message || ''),
      duration: hold,
    };
    set((s) => ({ toasts: [...s.toasts.slice(-4), toast] }));
    return id;
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  ask: (options = {}) => {
    const prev = get().confirming;
    if (prev?.resolve) prev.resolve(false);
    return new Promise((resolve) => {
      set({
        confirming: {
          title: options.title || 'Confirm this action',
          message: options.message || 'Do you want to continue?',
          confirmLabel: options.confirmLabel || 'Confirm',
          cancelLabel: options.cancelLabel || 'Cancel',
          variant: options.variant || (options.danger ? 'danger' : 'info'),
          mode: options.mode || 'ask',
          resolve,
        },
      });
    });
  },

  showProgress: (options = {}) => {
    set({
      confirming: {
        title: options.title || 'Working',
        message: options.message || 'Please wait. This can take a few seconds.',
        confirmLabel: options.confirmLabel || 'Working…',
        cancelLabel: 'Cancel',
        variant: options.variant || 'info',
        mode: 'busy',
        resolve: null,
      },
    });
  },

  finishConfirm: (accepted) => {
    const current = get().confirming;
    if (!current || current.mode === 'busy') return;
    set({ confirming: null });
    current.resolve?.(Boolean(accepted));
  },
}));

export const notify = {
  success: () => {},
  error: () => {},
  warning: () => {},
  info: () => {},
};

export function confirmAction(options) {
  return useNoticeStore.getState().ask(options);
}

export function acknowledgeAction(options) {
  return useNoticeStore.getState().ask({
    mode: 'ack',
    title: options.title || 'Done',
    message: options.message || 'The action completed.',
    confirmLabel: options.confirmLabel || 'OK',
    variant: options.variant || 'success',
  });
}

export async function confirmThenRun(options) {
  const store = useNoticeStore.getState();
  if (!options.skipConfirm) {
    const accepted = await store.ask({
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      variant: options.variant,
      danger: options.danger,
    });
    if (!accepted) return { ok: false, cancelled: true };
  }

  store.showProgress({
    title: options.busyTitle || options.title || 'Working',
    message: options.busyMessage || 'Please wait. This can take a few seconds.',
    confirmLabel: options.busyLabel || 'Working…',
  });

  try {
    const result = await options.work();
    const doneMessage = typeof options.successMessage === 'function'
      ? options.successMessage(result)
      : options.successMessage;
    await store.ask({
      mode: 'ack',
      title: options.successTitle || 'Done',
      message: doneMessage || 'The action completed.',
      confirmLabel: 'OK',
      variant: 'success',
    });
    return { ok: true, cancelled: false, result };
  } catch (error) {
    await store.ask({
      mode: 'ack',
      title: options.errorTitle || 'Action failed',
      message: actionErrorMessage(error, options.errorFallback),
      confirmLabel: 'OK',
      variant: 'danger',
    });
    return { ok: false, cancelled: false, error };
  }
}
