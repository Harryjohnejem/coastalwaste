import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export default function Modal({
  open,
  onClose,
  labelledBy,
  size,
  stacked = false,
  children,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (stacked) e.stopImmediatePropagation();
      onClose?.();
    };
    document.addEventListener('keydown', onKey, stacked);
    return () => document.removeEventListener('keydown', onKey, stacked);
  }, [open, onClose, stacked]);

  const node = (
    <div
      className={`modal-backdrop${open ? ' open' : ''}${stacked ? ' stacked' : ''}`}
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

  if (!open) return null;
  if (typeof document === 'undefined') return node;
  return createPortal(node, document.body);
}
