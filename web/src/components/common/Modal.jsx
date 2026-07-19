import { useEffect } from 'react';

export default function Modal({
  open,
  onClose,
  labelledBy,
  size,
  children,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      className={`modal-backdrop${open ? ' open' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className={`modal${size === 'sm' ? ' sm' : ''}`}>{children}</div>
    </div>
  );
}
