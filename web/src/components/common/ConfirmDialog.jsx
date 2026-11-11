import Modal from './Modal';
import NoticeGlyph from './NoticeGlyph';
import { useNoticeStore } from '../../stores/useNoticeStore';

export default function ConfirmDialog() {
  const confirming = useNoticeStore((s) => s.confirming);
  const finishConfirm = useNoticeStore((s) => s.finishConfirm);

  const open = Boolean(confirming);
  const variant = confirming?.variant || 'info';
  const mode = confirming?.mode || 'ask';
  const busy = mode === 'busy';
  const ack = mode === 'ack';
  const glyphType = variant === 'danger' ? 'error' : variant;

  const cancel = () => {
    if (busy) return;
    finishConfirm(ack ? true : false);
  };
  const accept = () => {
    if (busy) return;
    finishConfirm(true);
  };

  return (
    <Modal open={open} onClose={cancel} labelledBy="app-confirm-title" size="sm" stacked>
      {confirming ? (
        <div className="app-confirm" aria-busy={busy}>
          <div className="modal-head">
            <h3 id="app-confirm-title">{confirming.title}</h3>
            <button
              className="modal-close"
              type="button"
              onClick={cancel}
              aria-label="Close"
              disabled={busy}
            >
              ×
            </button>
          </div>
          <div className="modal-body">
            <div className={`app-confirm-lead ${busy ? 'info' : variant}`}>
              <span className="app-notice-icon">
                {busy ? (
                  <span className="app-confirm-spinner" aria-hidden="true" />
                ) : (
                  <NoticeGlyph type={glyphType} />
                )}
              </span>
              <p>{confirming.message}</p>
            </div>
          </div>
          <div className="modal-foot">
            {busy || ack ? null : (
              <button className="btn-ghost" type="button" onClick={cancel}>
                {confirming.cancelLabel}
              </button>
            )}
            <button
              className={variant === 'danger' && !busy && !ack ? 'btn-danger btn-danger-solid' : 'btn-save'}
              type="button"
              onClick={accept}
              disabled={busy}
            >
              {busy ? (
                <span className="app-confirm-busy">
                  <span className="app-confirm-spinner" aria-hidden="true" />
                  {confirming.confirmLabel}
                </span>
              ) : (
                confirming.confirmLabel
              )}
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
