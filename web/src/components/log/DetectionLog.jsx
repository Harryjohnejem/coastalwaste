import { useSettingsStore } from '../../stores/useSettingsStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { classifyWaste } from '../../lib/wasteFilters';
import {
  nextReportNumber,
  buildOfficialReportHtml,
  saveAndPrintReport,
} from '../../lib/reportForm';

/** Map detection → icon kind for accurate waste-type glyphs. */
function iconKindFor(det) {
  const label = String(det?.class || det?.title || '').toLowerCase();
  const { category, subtype } = classifyWaste(det);

  if (/(person|people|human)/.test(label)) return 'person';
  if (/(boat|vessel|ship)/.test(label)) return 'boat';
  if (/(surfboard|skateboard)/.test(label)) return 'board';
  if (/(bird|dog|cat|animal)/.test(label)) return 'wildlife';
  if (/(vase|bowl|pot)/.test(label)) return 'vessel';

  if (subtype === 'Fishing Net' || /(fishing|net)/.test(label)) return 'net';
  if (subtype === 'Styrofoam' || /(styrofoam|foam)/.test(label)) return 'foam';
  if (subtype === 'Plastic Bag' || /(bag)/.test(label)) return 'bag';
  if (subtype === 'Plastic Cup' || /(cup)/.test(label)) return 'cup';
  if (subtype === 'Plastic Bottle' || (/(bottle)/.test(label) && !/(glass)/.test(label))) {
    return 'bottle';
  }

  if (category === 'Papers' || /(paper|cardboard|newspaper)/.test(label)) return 'paper';
  if (category === 'Metals' || /(can|metal|aluminum|aluminium)/.test(label)) return 'metal';
  if (category === 'Glass' || /(glass)/.test(label)) return 'glass';
  if (category === 'Wood' || /(wood|driftwood|pallet)/.test(label)) return 'wood';
  if (category === 'Plastics') return 'plastic';

  return 'other';
}

function WasteIcon({ kind }) {
  const props = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.75',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };

  switch (kind) {
    case 'bottle':
      return (
        <svg {...props}>
          <path d="M9 2h6" />
          <path d="M10 2v3.2c0 .8-.3 1.5-.8 2.1L8 9.5V20a2 2 0 002 2h4a2 2 0 002-2V9.5l-1.2-2.2c-.5-.6-.8-1.3-.8-2.1V2" />
          <path d="M9 13h6" />
        </svg>
      );
    case 'bag':
      return (
        <svg {...props}>
          <path d="M6 8h12l-1 13H7L6 8z" />
          <path d="M9 8V6.5A3 3 0 0115 6.5V8" />
          <path d="M10 12v4M14 12v4" />
        </svg>
      );
    case 'cup':
      return (
        <svg {...props}>
          <path d="M7 4h10l-1.2 12.5A2 2 0 0113.8 18h-3.6a2 2 0 01-2-1.5L7 4z" />
          <path d="M17 7h1.5a2.5 2.5 0 010 5H16" />
          <path d="M9 21h6" />
        </svg>
      );
    case 'foam':
      return (
        <svg {...props}>
          <rect x="4" y="7" width="16" height="11" rx="2" />
          <path d="M7 11h.01M12 11h.01M17 11h.01M9.5 15h.01M14.5 15h.01" />
          <path d="M8 7V5.5A1.5 1.5 0 019.5 4h5A1.5 1.5 0 0116 5.5V7" />
        </svg>
      );
    case 'net':
      return (
        <svg {...props}>
          <path d="M4 6h16M4 12h16M4 18h16" />
          <path d="M7 4v16M12 4v16M17 4v16" />
          <circle cx="7" cy="6" r="0.8" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
          <circle cx="17" cy="18" r="0.8" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'plastic':
      return (
        <svg {...props}>
          <path d="M8 3h8v3l2 3v10a2 2 0 01-2 2H8a2 2 0 01-2-2V9l2-3V3z" />
          <path d="M8 9h8" />
        </svg>
      );
    case 'paper':
      return (
        <svg {...props}>
          <path d="M7 3h7l4 4v14a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
          <path d="M14 3v4h4M9 12h6M9 16h6M9 8h2" />
        </svg>
      );
    case 'metal':
      return (
        <svg {...props}>
          <path d="M8 7h8l1 3v9a2 2 0 01-2 2H9a2 2 0 01-2-2v-9l1-3z" />
          <path d="M8 10h8M10 4h4v3" />
          <path d="M10 14h4" />
        </svg>
      );
    case 'glass':
      return (
        <svg {...props}>
          <path d="M9 2h6v4l2 4v9a2 2 0 01-2 2H9a2 2 0 01-2-2v-9l2-4V2z" />
          <path d="M9 10h6" />
          <path d="M11 14v3" />
        </svg>
      );
    case 'wood':
      return (
        <svg {...props}>
          <path d="M4 8l8-4 8 4v9l-8 4-8-4V8z" />
          <path d="M12 4v17M4 8l8 4 8-4" />
        </svg>
      );
    case 'person':
      return (
        <svg {...props}>
          <circle cx="12" cy="7" r="3" />
          <path d="M5 21v-1a6 6 0 0112 0v1" />
        </svg>
      );
    case 'boat':
      return (
        <svg {...props}>
          <path d="M3 16l2 3h14l2-3H3z" />
          <path d="M6 16V9l6-3 6 3v7" />
          <path d="M12 6v10" />
        </svg>
      );
    case 'board':
      return (
        <svg {...props}>
          <path d="M4 14c2-4 6-6 8-6s6 2 8 6c-2 4-6 6-8 6s-6-2-8-6z" />
          <path d="M8 14h8" />
        </svg>
      );
    case 'wildlife':
      return (
        <svg {...props}>
          <circle cx="12" cy="10" r="4" />
          <path d="M8 8.5V6M16 8.5V6M9 21c0-2 1.5-3.5 3-3.5s3 1.5 3 3.5" />
        </svg>
      );
    case 'vessel':
      return (
        <svg {...props}>
          <path d="M7 10h10l-1.5 8H8.5L7 10z" />
          <path d="M9 10V7a3 3 0 016 0v3" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v5M12 16h.01" />
        </svg>
      );
  }
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
  const composition = useSettingsStore((s) => s.composition);
  const stats = useSettingsStore((s) => s.stats);
  const quotas = useSettingsStore((s) => s.quotas);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const user = useAuthStore((s) => s.user);
  const rows = [...liveDetections, ...detections];
  const quota = (quotas || [])[0];

  const handleReport = async () => {
    const reportNumber = nextReportNumber();
    const now = new Date();
    const monitoringPeriod = `Paco Beach, Barangay Gracia · ${now.toLocaleDateString('en-PH', {
      month: 'long',
      year: 'numeric',
    })}`;
    const html = buildOfficialReportHtml({
      reportNumber,
      reportType: 'Detailed',
      generatedBy: user?.name || user?.email || 'Administrator',
      monitoringPeriod,
      stats: stats || {},
      composition: composition || [],
      detections: rows,
      quota: quota || null,
      remarks: 'Cleanup report filed from Live Monitor detection log.',
    });
    await saveAndPrintReport(
      {
        report_type: 'Detailed',
        monitoring_period: monitoringPeriod,
        remarks: 'Cleanup report filed from Live Monitor detection log.',
        recommendations:
          quota?.status === 'reached'
            ? quota.cleanup_recommendation
            : 'Conduct coastal cleanup as needed based on current detections.',
      },
      html,
    );
  };

  return (
    <section className="panel" style={{ flex: 1.4, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="panel-head">
        <span className="panel-title">Detection log</span>
        <button className="mini-link" type="button">
          Export CSV
        </button>
      </div>
      {quota && (
        <button
          type="button"
          className={`quota-strip is-${quota.status}`}
          onClick={() => openSettings('quota')}
        >
          <span className="quota-strip-label">Waste quota</span>
          <span className="quota-strip-val">
            {quota.current_count}/{quota.quota_limit}
          </span>
          <span className="quota-strip-bar" aria-hidden="true">
            <i style={{ width: `${Math.min(100, quota.percent || 0)}%` }} />
          </span>
        </button>
      )}
      <div className="log-scroll">
        {loading && rows.length === 0 && (
          <>
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </>
        )}
        {rows.map((d) => {
          const { category } = classifyWaste(d);
          const kind = iconKindFor(d);
          const sev = severityClass(d.severity);
          const conf =
            d.confidence != null ? Number(d.confidence).toFixed(2) : '—';
          const sub =
            d.subtitle ||
            [d.camera_id, d.sector, d.detected_at].filter(Boolean).join(' · ');
          return (
            <article
              key={d.id}
              className={`det${sev ? ` ${sev}` : ''} ik-${kind}`}
            >
              <div className={`det-icon ik-${kind}`} title={category}>
                <WasteIcon kind={kind} />
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
