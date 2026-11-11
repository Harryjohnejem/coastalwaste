import { useEffect, useState } from 'react';
import { POLL_INTERVAL_MS } from '../../constants';
import usePageVisible from '../../hooks/usePageVisible';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useCameraStore } from '../../stores/useCameraStore';
import { listDetections } from '../../api/detections';
import { classifyWaste } from '../../lib/wasteFilters';

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

  if (category === 'Paper' || /(paper|cardboard)/.test(label)) return 'paper';
  if (category === 'Metal' || /(^can$|metal)/.test(label)) return 'metal';
  if (category === 'Glass' || /(glass)/.test(label)) return 'glass';
  if (category === 'Plastic') return 'plastic';

  return 'other';
}

function statusLabel(status) {
  if (status === 'Present') return 'Active';
  if (status === 'Confirmed Cleaned') return 'Confirmed Clean';
  return status || '';
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

function trackIdOf(row) {
  const match = String(row?.subtitle || '').match(/Track\s+(\d+)/i);
  return match ? match[1] : null;
}

/** One visible row per tracking ID. Live rows come first and win over the saved copy. */
function dedupeByTrack(items) {
  const seen = new Set();
  const kept = [];
  for (const row of items) {
    const trackId = trackIdOf(row);
    if (trackId) {
      if (seen.has(trackId)) continue;
      seen.add(trackId);
    }
    kept.push(row);
  }
  return kept;
}

function formatWhen(value) {
  if (!value) return 'none';
  const dt = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(dt.getTime())) return String(value);
  return dt.toLocaleString('en-PH', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function logSnapshot(rows) {
  const list = rows || [];
  if (!list.length) {
    return { latest: 'none', top: 'none', confidence: '—' };
  }
  const latest = [...list].sort((a, b) => String(b.detected_at || '').localeCompare(String(a.detected_at || '')))[0];
  const counts = {};
  let confidenceTotal = 0;
  let confidenceCount = 0;
  list.forEach((row) => {
    const name = row.class || 'Unknown';
    counts[name] = (counts[name] || 0) + 1;
    if (row.confidence != null && !Number.isNaN(Number(row.confidence))) {
      const score = Number(row.confidence);
      confidenceTotal += score <= 1 ? score * 100 : score;
      confidenceCount += 1;
    }
  });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return {
    latest: formatWhen(latest?.detected_at),
    top: top ? `${top[0]} · ${top[1]}` : 'none',
    confidence: confidenceCount ? `${Math.round(confidenceTotal / confidenceCount)}%` : '—',
  };
}

function severityClass(severity) {
  if (severity === 'warn' || severity === 'warning') return 'warn';
  if (severity === 'info') return 'info';
  return '';
}

function score01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n > 1.5 ? n / 100 : n;
}

function visibleLiveBoxes(boxes, meta, cameraId, minConf) {
  const id = String(cameraId || '').toUpperCase();
  const floor = Math.max(0.8, Number(minConf) || 0.8);
  const detectPublishMs = meta?.detectToPublishMs ?? null;
  const overlayAgeMs =
    meta?.overlayAgeMs ??
    (meta?.overlayPublishedAt != null
      ? Math.max(0, Math.round((Date.now() / 1000 - meta.overlayPublishedAt) * 1000))
      : null);
  const staleMs = Math.max(25000, (detectPublishMs || 0) * 4 + 4000);
  if (overlayAgeMs != null && overlayAgeMs > staleMs) return [];
  return (boxes || []).filter((box) => {
    if (box?.needs_label) return false;
    const boxCam = String(box.camera_id || meta?.cameraId || '').toUpperCase();
    if (boxCam && id && boxCam !== id) return false;
    return score01(box.confidence) >= floor;
  });
}

function rowsFromLiveBoxes(boxes, presentRows, cameraId) {
  const byTrack = new Map();
  presentRows.forEach((row) => {
    const trackId = trackIdOf(row);
    if (trackId) byTrack.set(String(trackId), row);
  });
  return boxes.map((box, index) => {
    const track = box.track_id != null ? String(box.track_id) : null;
    const saved = track ? byTrack.get(track) : null;
    if (saved) {
      return {
        ...saved,
        class: box.class || saved.class,
        confidence: box.confidence ?? saved.confidence,
        status: 'Present',
      };
    }
    return {
      id: `live-${cameraId}-${track || index}`,
      class: box.class || 'Waste',
      confidence: box.confidence,
      camera_id: cameraId,
      status: 'Present',
      subtitle: [track ? `Track ${track}` : null, cameraId].filter(Boolean).join(' · '),
      detected_at: new Date().toISOString(),
    };
  });
}

export default function DetectionLog() {
  const pageVisible = usePageVisible();
  const loading = useSettingsStore((s) => s.detectionsLoading);
  const stats = useSettingsStore((s) => s.stats);
  const statsReady = useSettingsStore((s) => s.statsReady);
  const statsError = useSettingsStore((s) => s.statsError);
  const hudConf = useSettingsStore((s) => s.settings?.detection?.confidence ?? 0.8);
  const activeCameraId = useCameraStore((s) => s.activeCameraId);
  const overlayMeta = useCameraStore((s) => s.overlayMeta);
  const overlayBoxes = useCameraStore((s) => s.overlayBoxes);
  const overlayKnown = useCameraStore((s) => s.overlayKnown);
  const detectionOn = useCameraStore((s) => s.detectionOn);
  const [savedPresent, setSavedPresent] = useState([]);
  const [liveLoading, setLiveLoading] = useState(false);

  useEffect(() => {
    if (!detectionOn || !activeCameraId) {
      setSavedPresent([]);
      setLiveLoading(false);
      return undefined;
    }
    let cancelled = false;
    let running = false;
    const loadPresent = ({ silent } = {}) => {
      if (running) return Promise.resolve();
      running = true;
      if (!silent) setLiveLoading(true);
      return listDetections(50, { camera_id: activeCameraId, status: 'Present' })
        .then((list) => {
          if (cancelled) return;
          const rows = Array.isArray(list) ? list : list?.data ?? [];
          setSavedPresent(rows.filter((row) => row?.status === 'Present' && row?.camera_id === activeCameraId));
        })
        .catch(() => {
          if (!cancelled) setSavedPresent([]);
        })
        .finally(() => {
          running = false;
          if (!cancelled) setLiveLoading(false);
        });
    };
    loadPresent();
    const timer = pageVisible
      ? setInterval(() => {
        loadPresent({ silent: true });
      }, POLL_INTERVAL_MS)
      : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [activeCameraId, detectionOn, pageVisible]);

  const cameraLive = overlayMeta?.cameraId
    ? String(overlayMeta.cameraId).toUpperCase() === String(activeCameraId || '').toUpperCase()
    : false;
  const cameraDisconnected = cameraLive && overlayMeta?.connected === false;
  const liveBoxes = visibleLiveBoxes(
    overlayBoxes,
    overlayMeta,
    activeCameraId,
    overlayMeta?.hudConf ?? hudConf,
  );
  const presentRows = dedupeByTrack(savedPresent.filter((row) => Number.isInteger(row?.id)));
  let rows = [];
  if (detectionOn && activeCameraId && !cameraDisconnected) {
    rows = overlayKnown
      ? rowsFromLiveBoxes(liveBoxes, presentRows, activeCameraId)
      : presentRows;
  }
  const snapshot = logSnapshot(rows);
  const presentCount = rows.length;
  const areaText = !activeCameraId
    ? 'Select a camera to see its live detections.'
    : !detectionOn
      ? `Detection is off. The live log is paused. Saved records stay in Waste Detections${
        statsReady ? ` (${Number(stats?.total_detections ?? 0).toLocaleString('en-US')})` : ''
      }.`
      : cameraDisconnected
        ? `${activeCameraId} is not updating. Live tracking cannot mark the scene clean until the stream is back.`
        : presentCount > 0
          ? `Waste is in view on ${activeCameraId}.`
          : liveLoading && !overlayKnown
            ? 'Loading live detections…'
            : `No waste currently in view on ${activeCameraId}.`;
  const areaHint = !detectionOn
    ? 'Turn detection on to see waste here as it appears. When an object leaves the camera, it is marked Confirmed Clean and leaves this log. Historical records stay in Waste Detections.'
    : 'When an object leaves the camera, it is marked Confirmed Clean and leaves this live log. That is inferred disappearance, not verified physical cleaning.';
  const emptyText = !detectionOn
    ? 'Detection is off. No live detections will appear until you turn detection on.'
    : cameraDisconnected
      ? 'Live tracking is paused. Historical records stay on Waste Detections.'
      : `No waste currently in view on ${activeCameraId || 'this camera'}.`;

  return (
    <section className="panel" style={{ flex: 1.4, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="panel-head">
        <span className="panel-title">Detection log</span>
        <button className="mini-link" type="button">
          Export CSV
        </button>
      </div>
      <div className="log-metrics" aria-label="Detection summary">
        <div className="log-metric">
          <span>Total</span>
          <strong>{statsReady ? Number(stats?.total_detections ?? 0).toLocaleString('en-US') : '—'}</strong>
        </div>
        <div className="log-metric">
          <span>Today</span>
          <strong>{statsReady ? Number(stats?.detections ?? 0).toLocaleString('en-US') : '—'}</strong>
        </div>
        <div className="log-metric is-present">
          <span>Active</span>
          <strong>{activeCameraId ? presentCount.toLocaleString('en-US') : '—'}</strong>
        </div>
        <div className="log-metric is-clean">
          <span>Confirmed Clean</span>
          <strong>{statsReady ? Number(stats?.confirmed_cleaned ?? 0).toLocaleString('en-US') : '—'}</strong>
        </div>
      </div>
      <div className={`log-clear${!detectionOn ? ' is-paused' : ''}`}>
        <strong>{statsError || areaText}</strong>
        <span>
          {areaHint}
          {' '}Inferred removals today: {statsReady ? Number(stats?.confirmed_cleaned_today ?? 0) : '—'}.
        </span>
      </div>
      <div className="log-extra">
        <div>
          <span>Latest record</span>
          <b>{snapshot.latest}</b>
        </div>
        <div>
          <span>Most seen</span>
          <b>{snapshot.top}</b>
        </div>
        <div>
          <span>Avg confidence</span>
          <b>{snapshot.confidence}</b>
        </div>
      </div>
      <div className="log-scroll">
        {loading && rows.length === 0 && (
          <>
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </>
        )}
        {!loading && rows.length === 0 && (
          <p className={`log-empty${!detectionOn ? ' is-paused' : ''}`}>
            {emptyText}
          </p>
        )}
        {rows.map((d) => {
          const { category, subtype } = classifyWaste(d);
          const className = subtype || d.class || d.title || 'Waste';
          const kind = iconKindFor(d);
          const sev = severityClass(d.severity);
          const conf =
            d.confidence != null ? Number(d.confidence).toFixed(2) : '—';
          const camSrc = d.detection_source || d.camera_id;
          const sub =
            d.subtitle ||
            [camSrc, d.sector, d.detected_at].filter(Boolean).join(' · ');
          const attrLabel =
            d.dataset_attribution_label ||
            'Unknown / Not Attributable';
          const attrTip =
            d.dataset_attribution_tooltip ||
            'Training-dataset attribution is separate from the camera that captured the frame.';
          return (
            <article
              key={d.id}
              className={`det${sev ? ` ${sev}` : ''} ik-${kind}`}
            >
              <div className={`det-icon ik-${kind}`} title={category}>
                <WasteIcon kind={kind} />
              </div>
              <div className="det-body">
                <div className="det-title">{className}</div>
                <div className="det-sub">
                  {category ? `Category: ${category}` : 'Category: —'}
                  <br />
                  {sub}
                  {d.status ? ` · ${statusLabel(d.status)}` : ''}
                  {d.status === 'Confirmed Cleaned' && d.removed_at ? ` · ${formatWhen(d.removed_at)}` : ''}
                  <br />
                  <span title={attrTip}>
                    Detection source: {camSrc || '—'} · Dataset: {attrLabel}
                  </span>
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
    </section>
  );
}
