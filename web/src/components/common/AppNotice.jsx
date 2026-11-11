import NoticeGlyph from './NoticeGlyph';

export default function AppNotice({ type = 'info', title, message, onDismiss }) {
  if (!message) return null;
  const role = type === 'error' || type === 'danger' ? 'alert' : 'status';
  return (
    <div className={`app-notice ${type}`} role={role}>
      <span className="app-notice-icon">
        <NoticeGlyph type={type} />
      </span>
      <div className="app-notice-copy">
        {title ? <strong>{title}</strong> : null}
        <p>{message}</p>
      </div>
      {onDismiss ? (
        <button className="app-notice-close" type="button" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      ) : null}
    </div>
  );
}
