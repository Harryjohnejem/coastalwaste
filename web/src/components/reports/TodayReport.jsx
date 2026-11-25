import { useCallback, useEffect, useRef, useState } from 'react';
import { getTodayReport } from '../../api/reports';
import { useAuthStore } from '../../stores/useAuthStore';
import usePageVisible from '../../hooks/usePageVisible';
import ModeSwitch from '../common/ModeSwitch';
import AccountMenu from './AccountMenu';
import { useTodayReportStore } from '../../stores/useTodayReportStore';
import { usePageSwitchStore } from '../../stores/usePageSwitchStore';
import ReportFormPanel from './ReportFormPanel';
import VerifyCleaningModal from './VerifyCleaningModal';
import { FLASH_CLEANUP_KEY } from '../../stores/useFocusStore';

// Real time: follows the live streams and new detections every few seconds.
const REFRESH_MS = 3000;

/** Shown until the first numbers arrive, so the page never waits on a loading screen. */
const EMPTY_REPORT = {
  generated_at: null,
  live_model: {},
  cameras_online: 0,
  cameras_total: 0,
  live_now: { count: 0, classes: [] },
  kpis: {},
  hourly: [],
  classes: [],
  cameras: [],
  attention: {},
};

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function dateLabel(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function initials(name) {
  const parts = String(name || 'U').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
}

/** Small bar sparkline: the last 12 hours, the latest bar in the card color. */
function Spark({ values = [], tone }) {
  const recent = values.slice(-12);
  const max = Math.max(1, ...recent);
  return (
    <div className={`tr-spark tone-${tone}`} aria-hidden="true">
      {recent.map((v, i) => (
        <span
          key={i}
          className={i === recent.length - 1 ? 'is-last' : ''}
          style={{ height: `${Math.max(12, (Number(v) / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function Delta({ value, suffix = '%', invert = false, empty = 'no data yesterday' }) {
  if (value == null) return <span className="tr-delta is-flat">—</span>;
  const good = invert ? value <= 0 : value >= 0;
  const sign = value > 0 ? '+' : '';
  return (
    <span className={`tr-delta ${good ? 'is-good' : 'is-bad'}`} title={empty}>
      {sign}
      {value}
      {suffix}
    </span>
  );
}

function KpiCard({ tone, label, value, unit, delta, deltaSuffix, invert, note, spark, chip }) {
  return (
    <section className="tr-card tr-kpi">
      <div className="tr-kpi-label">
        <span className={`tr-dot tone-${tone}`} />
        {label}
      </div>
      <div className="tr-kpi-row">
        <div className="tr-kpi-value">
          {value}
          {unit ? <small>{unit}</small> : null}
        </div>
        <Spark values={spark} tone={tone} />
      </div>
      <div className="tr-kpi-foot">
        {chip ? <span className={`tr-delta ${chip.bad ? 'is-bad' : 'is-good'}`}>{chip.text}</span> : null}
        {!chip && delta !== undefined ? <Delta value={delta} suffix={deltaSuffix} invert={invert} /> : null}
        <span>{note}</span>
      </div>
    </section>
  );
}

function MeterRow({ label, value, max, tone }) {
  return (
    <div className="tr-meter">
      <div className="tr-meter-top">
        <span>{label}</span>
        <b>{fmt(value)}</b>
      </div>
      <div className="tr-meter-track">
        <span className={`tone-${tone}`} style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} />
      </div>
    </div>
  );
}

/**
 * Today's report: real-time numbers from today's Waste Detections.
 * Opened from the welcome modal ("Tan-awa ang report karon") or the side menu.
 */
const LEVEL_TEXT = { normal: 'Normal', warning: 'Building up', full: 'Full' };

/** Cleanup threshold: waste still on the beach per camera vs the limit in Settings. */
function CleanupCard({ load }) {
  if (!load) return null;
  const cams = load.cameras || [];
  return (
    <section className={`tr-card tr-cleanup is-${load.level}`}>
      <header className="tr-card-head">
        <div>
          <h3>Cleanup threshold</h3>
          <p>
            Limit {load.limit} items per camera · warning at {load.warn_at}
            {load.enabled ? '' : ' · alerts off'}
          </p>
        </div>
        <span className={`tr-level is-${load.level}`}>{LEVEL_TEXT[load.level] || 'Normal'}</span>
      </header>
      {cams.map((c) => (
        <div key={c.code} className={`tr-cleanup-row is-${c.level}`}>
          <div className="tr-cleanup-top">
            <span>{c.code}{c.name ? ` · ${c.name}` : ''}</span>
            <b>{c.count}/{load.limit}</b>
          </div>
          <span className="cleanup-meter">
            <span style={{ width: `${Math.min(100, c.percent)}%` }} />
            <i style={{ left: `${load.warn_percent}%` }} />
          </span>
        </div>
      ))}
      {load.level === 'full' ? (
        <p className="tr-warn">The beach has reached the cleanup limit — send a cleanup team now.</p>
      ) : load.level === 'warning' ? (
        <p className="tr-warn">Waste is building up — plan a cleanup soon.</p>
      ) : (
        <p className="tr-good">Below the warning level on every camera.</p>
      )}
    </section>
  );
}

export default function TodayReport() {
  const startSwitch = usePageSwitchStore((s) => s.start);
  // This page is outside the main dashboard; buttons open the dashboard on a module.
  const setModule = (module) => {
    startSwitch('/', 'Loading Live Monitoring Dashboard…', module);
  };
  const user = useAuthStore((s) => s.user);

  // Opened from a cleanup notification: bring the Cleanup threshold card into view.
  useEffect(() => {
    let flash = false;
    try {
      flash = sessionStorage.getItem(FLASH_CLEANUP_KEY) === '1';
      sessionStorage.removeItem(FLASH_CLEANUP_KEY);
    } catch {
      flash = false;
    }
    if (!flash) return undefined;
    const id = setTimeout(() => {
      const card = document.querySelector('.tr-cleanup');
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove('is-flash');
      void card.offsetWidth;
      card.classList.add('is-flash');
    }, 400);
    return () => clearTimeout(id);
  }, []);
  const visible = usePageVisible();
  const cached = useTodayReportStore((s) => s.report);
  const setReport = useTodayReportStore((s) => s.setReport);
  const [error, setError] = useState('');
  const [verifyOpen, setVerifyOpen] = useState(false);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setReport(await getTodayReport());
      setError('');
    } catch {
      setError('Could not refresh the report. Showing the last numbers.');
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [visible, load]);

  const report = cached || EMPTY_REPORT;

  const k = report.kpis || {};
  const cameras = report.cameras || [];
  const cameraTotal = cameras.reduce((sum, c) => sum + c.count, 0);
  const attention = report.attention || {};
  const attentionMax = Math.max(1, attention.long_present || 0, attention.pending_reviews || 0);
  const live = report.live_model || {};
  const detections = k.detections?.value || 0;

  return (
    <div className="today-report">
      <div className="tr-shell">
        <div className="tr-top">
          <div className="tr-crumbs">
            <img className="tr-logo" src="/brgy-gracia-seal.jpg" alt="Barangay Gracia seal" />
            <span>Brgy. Gracia</span>
            <span aria-hidden="true">/</span>
            <b>Dashboard</b>
          </div>
          <div className="tr-top-right">
            <span className="tr-updated">
              {report.generated_at ? `Updated ${timeLabel(report.generated_at)}` : <><span className="tr-spinner" aria-hidden="true" /> Loading…</>}
            </span>
            <ModeSwitch className="tr-mode" />
            <AccountMenu />
          </div>
        </div>

        <div className="tr-title-row">
          <div className="tr-title">
            <span className="tr-badge" aria-hidden="true">
              {/* Report sheet: folded corner, bar chart and text lines. */}
              <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4h18l10 10v26a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4Z" />
                <path d="M30 4v8a2 2 0 0 0 2 2h8" />
                <path d="M13 23.5h19" />
                <rect x="15" y="17" width="3.6" height="6.5" rx=".6" />
                <rect x="21" y="13.5" width="3.6" height="10" rx=".6" />
                <rect x="27" y="10" width="3.6" height="13.5" rx=".6" />
                <path d="M14 29h10M29 29h6M14 34h7M25 34h5M33 34h2M14 39h12M30 39h5" />
              </svg>
            </span>
            <div>
              <div className="tr-title-line">
                <h2>Main Dashboard</h2>
                <span className="tr-live">
                  <i />
                  {report.generated_at ? `Live · ${report.cameras_online}/${report.cameras_total} cameras` : 'Connecting…'}
                </span>
              </div>
              <p>
                Paco Beach · {dateLabel(report.generated_at)} · model {live.model} / {live.dataset}
              </p>
            </div>
          </div>
          <div className="tr-actions">
            <button
              type="button"
              className="tr-btn is-verify"
              onClick={() => setVerifyOpen(true)}
              title="Confirm on site that waste which left the camera view was physically collected"
            >
              Verify cleaning
            </button>
            <button type="button" className="tr-btn is-dark" onClick={() => setModule('live')}>
              Switch to Live Monitoring Dashboard
            </button>
          </div>
        </div>

        {error ? <p className="tr-error">{error}</p> : null}

        <div className="tr-kpis">
          <KpiCard
            tone="blue"
            label="DETECTIONS TODAY"
            value={fmt(detections)}
            delta={k.detections?.delta_percent}
            note="vs same time yesterday"
            spark={k.detections?.spark}
          />
          <KpiCard
            tone="teal"
            label="NO LONGER VISIBLE"
            value={fmt(k.cleaned?.value)}
            delta={k.cleaned?.delta_percent}
            note={`inferred, not verified · ${fmt(k.verified?.value)} cleaning verified today`}
            spark={k.cleaned?.spark}
          />
          <KpiCard
            tone="slate"
            label="AVG CONFIDENCE"
            value={k.avg_confidence?.value == null ? '—' : k.avg_confidence.value}
            unit={k.avg_confidence?.value == null ? '' : '%'}
            delta={k.avg_confidence?.delta}
            deltaSuffix=" pts"
            note="vs yesterday"
            spark={k.avg_confidence?.spark}
          />
          <KpiCard
            tone="amber"
            label="STILL ON THE BEACH"
            value={fmt(k.present?.value)}
            chip={k.present?.long_present ? { text: `${fmt(k.present.long_present)} over 1 h`, bad: true } : { text: 'all recent', bad: false }}
            note={k.present?.long_present ? 'waiting for cleanup' : 'nothing waiting over an hour'}
            spark={k.present?.spark}
          />
        </div>

        <div className="tr-grid">
          <div className="tr-main">
            {/* The monitoring report (same as Reports & Analytics), in place of the hourly chart and the waste list. */}
            <ReportFormPanel />
          </div>

          <aside className="tr-side">
            <CleanupCard load={report.waste_load} />
            <section className="tr-card">
              <header className="tr-card-head">
                <h3>Where it was found</h3>
                <span className="tr-muted">{fmt(cameraTotal)} on camera now</span>
              </header>
              <div className="tr-section-label">BY CAMERA — PACO BEACH</div>
              {cameras.map((c) => (
                <div key={c.code}>
                  <MeterRow
                    label={`${c.code}${c.name ? ` · ${c.name}` : ''}`}
                    value={c.count}
                    max={Math.max(1, ...cameras.map((x) => x.count))}
                    tone="teal"
                  />
                  <div className={`tr-stream${c.streaming && c.detection_on !== false ? ' is-on' : ''}`}>
                    <i aria-hidden="true" />
                    {!c.streaming
                      ? 'Stream offline'
                      : c.detection_on === false
                        ? 'Detection off'
                        : `Streaming · ${fmt(c.today)} found today`}
                  </div>
                </div>
              ))}
              <p className="tr-good">
                {fmt(k.cleaned?.value)} no longer visible today (inferred) · {fmt(k.verified?.value)} cleaning verified.
              </p>
              <div className="tr-section-label">NEEDS ATTENTION</div>
              <MeterRow
                label={`Still on the beach over ${attention.long_present_minutes || 60} min`}
                value={attention.long_present || 0}
                max={attentionMax}
                tone="amber"
              />
              <MeterRow
                label="Detection Reviews waiting"
                value={attention.pending_reviews || 0}
                max={attentionMax}
                tone="amber"
              />
              {attention.long_present ? (
                <p className="tr-warn">
                  {fmt(attention.long_present)} {attention.long_present === 1 ? 'item has' : 'items have'} been on the
                  beach for over an hour — send a cleanup team.
                </p>
              ) : null}
            </section>

          </aside>
        </div>
      </div>
      <VerifyCleaningModal open={verifyOpen} onClose={() => setVerifyOpen(false)} onVerified={load} />
    </div>
  );
}
