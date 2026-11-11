import Modal from './Modal';
import { useNoticeStore } from '../../stores/useNoticeStore';

const ICONS = {
  success: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l10 18H2L12 3z" />
      <path d="M12 10v5M12 18h.01" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 8h.01" />
    </svg>
  ),
};

function ToastStack() {
  const toasts = useNoticeStore((s) => s.toasts);
  const dismissToast = useNoticeStore((s) => s.dismissToast);

  if (!toasts.length) return null;

  return (
    <div className="notice-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`notice-toast notice-${toast.type}`} role="status">
          <span className="notice-icon" aria-hidden="true">
            {ICONS[toast.type] || ICONS.info}
          </span>
          <div className="notice-copy">
            <strong>{toast.title}</strong>
            {toast.message ? <p>{toast.message}</p> : null}
          </div>
          <button
            type="button"
            className="notice-dismiss"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function ConfirmDialog() {
  const dialog = useNoticeStore((s) => s.dialog);
  const settle = useNoticeStore((s) => s.settle);
  const tone = dialog?.tone === 'danger' ? 'error' : dialog?.tone || 'warning';

  return (
    <Modal
      open={Boolean(dialog)}
      onClose={() => settle(false)}
      labelledBy="notice-confirm-title"
      size="sm"
      stacked
      className="notice-confirm-layer"
    >
      {dialog ? (
        <>
          <div className="modal-head">
            <h3 id="notice-confirm-title">
              <span className={`notice-confirm-mark notice-${tone}`} aria-hidden="true">
                {ICONS[tone] || ICONS.warning}
              </span>
              {dialog.title}
            </h3>
            <button
              className="modal-close"
              type="button"
              aria-label="Cancel"
              onClick={() => settle(false)}
            >
              ✕
            </button>
          </div>
          <div className="modal-body notice-confirm-body">
            <p>{dialog.message}</p>
          </div>
          <div className="modal-foot">
            <button className="btn-ghost" type="button" onClick={() => settle(false)}>
              {dialog.cancelLabel}
            </button>
            <button
              className={tone === 'error' ? 'btn-danger' : 'btn-save'}
              type="button"
              onClick={() => settle(true)}
            >
              {dialog.confirmLabel}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

export default function NoticeHost() {
  return (
    <>
      <ToastStack />
      <ConfirmDialog />
    </>
  );
}
