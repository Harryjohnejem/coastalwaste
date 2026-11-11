import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNoticeStore } from '../../stores/useNoticeStore';
import NoticeGlyph from './NoticeGlyph';

function ToastCard({ toast }) {
  const dismiss = useNoticeStore((s) => s.dismiss);

  useEffect(() => {
    if (!toast.duration || toast.duration < 0) return undefined;
    const id = setTimeout(() => dismiss(toast.id), toast.duration);
    return () => clearTimeout(id);
  }, [toast.id, toast.duration, dismiss]);

  return (
    <div className={`app-notice toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}>
      <span className="app-notice-icon">
        <NoticeGlyph type={toast.type} />
      </span>
      <div className="app-notice-copy">
        <strong>{toast.title}</strong>
        {toast.message ? <p>{toast.message}</p> : null}
      </div>
      <button className="app-notice-close" type="button" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

export default function ToastHost() {
  const toasts = useNoticeStore((s) => s.toasts);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="toast-host" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body,
  );
}
