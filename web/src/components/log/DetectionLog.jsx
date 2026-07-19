import { useSettingsStore } from '../../stores/useSettingsStore';

function DetIcon({ severity }) {
  if (severity === 'warn') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01" />
      </svg>
    );
  }
  if (severity === 'info') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M22 11.1V12a10 10 0 11-5.9-9.1" />
        <path d="M22 4L12 14l-3-3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 2h8l1 5c0 2-1 3-1 5v8a2 2 0 01-2 2h-4a2 2 0 01-2-2v-8c0-2-1-3-1-5z" />
    </svg>
  );
}

function severityClass(severity) {
  if (severity === 'warn' || severity === 'warning') return 'warn';
  if (severity === 'info') return 'info';
  return '';
}

export default function DetectionLog() {
  const detections = useSettingsStore((s) => s.detections);
  const liveDetections = useSettingsStore((s) => s.liveDetections);
  const loading = useSettingsStore((s) => s.detectionsLoading);
  const fileReport = useSettingsStore((s) => s.fileReport);
  const rows = [...liveDetections, ...detections];

  const handleReport = async () => {
    // TODO: open cleanup report form
    console.log('TODO: open cleanup report form');
    try {
      await fileReport({});
    } catch {
      /* API may be unavailable */
    }
  };

  return (
    <section className="panel" style={{ flex: 1.4, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="panel-head">
        <span className="panel-title">Detection log</span>
        <button className="mini-link" type="button">
          Export CSV
        </button>
      </div>
      <div className="log-scroll">
        {loading && rows.length === 0 && (
          <>
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </>
        )}
        {rows.map((d) => {
          const cls = severityClass(d.severity);
          const conf =
            d.confidence != null ? Number(d.confidence).toFixed(2) : '—';
          const sub =
            d.subtitle ||
            [d.camera_id, d.sector, d.detected_at].filter(Boolean).join(' · ');
          return (
            <article key={d.id} className={`det${cls ? ` ${cls}` : ''}`}>
              <div className="det-icon">
                <DetIcon severity={d.severity} />
              </div>
              <div className="det-body">
                <div className="det-title">{d.class || d.title}</div>
                <div className="det-sub">
                  {sub}
                  {d.subtitle ? null : d.count ? (
                    <>
                      <br />
                      {d.count} objects
                    </>
                  ) : null}
                </div>
              </div>
              <span className="det-conf">{conf}</span>
            </article>
          );
        })}
      </div>
      <button className="report-btn" type="button" onClick={handleReport}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </svg>
        File cleanup report
      </button>
    </section>
  );
}
