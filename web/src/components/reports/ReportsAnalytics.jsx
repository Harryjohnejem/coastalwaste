import { useMemo, useState } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useCameraStore } from '../../stores/useCameraStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { PARENT_CATEGORIES } from '../../constants';
import FilterSelect from '../common/FilterSelect';
import Modal from '../common/Modal';
import AppNotice from '../common/AppNotice';
import { confirmThenRun } from '../../stores/useNoticeStore';
import { datasetClassOf, parentCategoryOf } from '../../lib/reportForm';
import {
  nextReportNumber,
  buildOfficialReportHtml,
  buildMonitoringNotes,
  saveAndPrintReport,
} from '../../lib/reportForm';
import { emailReport } from '../../api/reports';

const DEFAULT_EMAIL_MESSAGE = 'Good day. The attached PDF is the Coastal Waste Monitoring and Reporting record for Paco Beach, Barangay Gracia, Tagoloan, Misamis Oriental. This message is sent by the Coastal Waste Monitoring and Reporting System.';
import {
  DATE_OPTIONS,
  CATEGORY_COLORS,
  periodBounds,
  previousPeriodBounds,
  inBounds,
  formatPeriodLabel,
  formatShortDate,
  countItems,
  rankedClasses,
  categoryRows,
  bucketDaily,
  bucketWeekly,
  bucketMonthly,
  percentChange,
  confidenceLabel,
  matchesCameraAndQuery,
  qty,
} from '../../lib/reportAnalytics';

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildCsv(detections, composition) {
  const lines = [
    'Republic of the Philippines',
    'Barangay Gracia, Tagoloan, Misamis Oriental',
    'Coastal Waste Monitoring and Reporting Form',
    'Monitoring location,Paco Beach, Barangay Gracia',
    `Generated,${new Date().toLocaleString()}`,
    '',
    'date_time,classification,category,camera,location,confidence,count',
  ];
  detections.forEach((d) => {
    const subtype = datasetClassOf(d);
    if (!subtype) return;
    lines.push(
      [
        `"${d.detected_at || ''}"`,
        `"${subtype}"`,
        `"${parentCategoryOf(d)}"`,
        d.camera_id || '',
        `"${d.location || d.sector || 'Paco Beach'}"`,
        confidenceLabel(d.confidence) || '',
        qty(d),
      ].join(','),
    );
  });
  lines.push('');
  lines.push('category,percent,count');
  composition.forEach((c) => {
    lines.push(`"${c.label}",${c.percent},${c.count ?? ''}`);
  });
  return lines.join('\n');
}

function KpiIcon({ name }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.8',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    width: 18,
    height: 18,
  };
  if (name === 'today') {
    return (
      <svg {...common}>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M8 3v4M16 3v4M3 11h18" />
      </svg>
    );
  }
  if (name === 'month') {
    return (
      <svg {...common}>
        <rect x="3" y="10" width="4" height="10" rx="1" />
        <rect x="10" y="6" width="4" height="14" rx="1" />
        <rect x="17" y="3" width="4" height="17" rx="1" />
      </svg>
    );
  }
  if (name === 'top') {
    return (
      <svg {...common}>
        <path d="M12 3l2.2 6.6H21l-5.4 3.9 2.1 6.5L12 16.8 6.3 20l2.1-6.5L3 9.6h6.8z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function KpiCard({ label, value, hint, delta, color, icon }) {
  const showDelta = delta && delta.percent != null;
  return (
    <article className="wa-kpi">
      <div className="wa-kpi-top">
        <span className="wa-kpi-icon" style={{ background: `${color}22`, color }}>
          <KpiIcon name={icon} />
        </span>
        {showDelta ? (
          <span className={`wa-kpi-delta ${delta.direction}`}>
            {delta.direction === 'down' ? '↓' : delta.direction === 'up' ? '↑' : '→'} {delta.percent}%
          </span>
        ) : null}
      </div>
      <div className="wa-kpi-mid">
        <div>
          <div className="wa-kpi-value">{value}</div>
          <div className="wa-kpi-label">{label}</div>
          {hint ? <p className="wa-kpi-hint">{hint}</p> : null}
        </div>
      </div>
    </article>
  );
}

function EmptyChart({ label }) {
  return (
    <div className="wa-empty" role="status">
      No recorded detections for {label}.
    </div>
  );
}

function GroupedMonthChart({ data }) {
  const max = Math.max(...data.flatMap((d) => PARENT_CATEGORIES.map((c) => d.counts[c])), 1);
  return (
    <div className="wa-grouped" role="img" aria-label="Monthly detections by category">
      {data.map((d) => (
        <div className="wa-grouped-col" key={`${d.label}-${d.year}`}>
          <div className="wa-grouped-bars">
            {PARENT_CATEGORIES.map((cat) => (
              <div
                key={cat}
                className="wa-grouped-bar"
                style={{
                  height: d.counts[cat]
                    ? `${Math.max(6, (d.counts[cat] / max) * 100)}%`
                    : '0%',
                  background: CATEGORY_COLORS[cat],
                }}
                title={`${d.label} ${d.year} · ${cat}: ${d.counts[cat]}`}
              />
            ))}
          </div>
          <span className="wa-dual-x">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function ReportsAnalytics() {
  const detections = useSettingsStore((s) => s.detections);
  const stats = useSettingsStore((s) => s.stats) || {};
  const statsReady = useSettingsStore((s) => s.statsReady);
  const detectionsError = useSettingsStore((s) => s.detectionsError);
  const detectionsLoading = useSettingsStore((s) => s.detectionsLoading);
  const detectionsLoaded = useSettingsStore((s) => s.detectionsLoaded);
  const cameras = useCameraStore((s) => s.cameras);
  const user = useAuthStore((s) => s.user);

  const [dateRange, setDateRange] = useState('All Dates');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [recordQuery, setRecordQuery] = useState('');
  const [cameraFilter, setCameraFilter] = useState('All Cameras');
  const [notesOpen, setNotesOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [recipientText, setRecipientText] = useState('');
  const [emailMessage, setEmailMessage] = useState(DEFAULT_EMAIL_MESSAGE);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailError, setEmailError] = useState('');

  const bounds = useMemo(
    () => periodBounds(dateRange, fromDate, toDate),
    [dateRange, fromDate, toDate],
  );
  const prevBounds = useMemo(
    () => previousPeriodBounds(bounds, dateRange),
    [bounds, dateRange],
  );

  const allDetections = useMemo(
    () =>
      (detections || []).filter(
        (d) => datasetClassOf(d) && String(d.status || '') !== 'Ignored',
      ),
    [detections],
  );

  const periodDetections = useMemo(
    () =>
      allDetections
        .filter((d) => inBounds(d, bounds))
        .filter((d) => matchesCameraAndQuery(d, cameraFilter, recordQuery))
        .slice()
        .sort((a, b) => String(b.detected_at || '').localeCompare(String(a.detected_at || ''))),
    [allDetections, bounds, cameraFilter, recordQuery],
  );

  const previousDetections = useMemo(() => {
    if (!prevBounds) return [];
    return allDetections
      .filter((d) => inBounds(d, prevBounds))
      .filter((d) => matchesCameraAndQuery(d, cameraFilter, recordQuery));
  }, [allDetections, prevBounds, cameraFilter, recordQuery]);

  const cameraOptions = useMemo(() => {
    const fromRecords = allDetections.map((d) => d.camera_id).filter(Boolean);
    const fromCameras = (cameras || []).map((c) => c.id).filter(Boolean);
    const ids = [...new Set([...fromCameras, ...fromRecords])];
    return [
      { value: 'All Cameras', label: 'All Cameras' },
      ...ids.map((id) => {
        const cam = (cameras || []).find((c) => c.id === id);
        return {
          value: id,
          label: cam?.name ? `${id} · ${String(cam.name).replace(`${id} · `, '')}` : id,
        };
      }),
    ];
  }, [allDetections, cameras]);

  const periodLabel = useMemo(
    () => formatPeriodLabel(dateRange, fromDate, toDate, bounds),
    [dateRange, fromDate, toDate, bounds],
  );

  const periodCount = countItems(periodDetections);
  const previousCount = countItems(previousDetections);
  const comparison = prevBounds ? percentChange(periodCount, previousCount) : null;

  const comp = useMemo(() => categoryRows(periodDetections), [periodDetections]);
  const topClasses = useMemo(() => rankedClasses(periodDetections, 5), [periodDetections]);
  const daily = useMemo(
    () => bucketDaily(periodDetections, bounds),
    [periodDetections, bounds],
  );
  const weekly = useMemo(
    () => bucketWeekly(periodDetections, bounds),
    [periodDetections, bounds],
  );
  const monthly = useMemo(
    () => bucketMonthly(periodDetections, bounds),
    [periodDetections, bounds],
  );

  const notes = useMemo(
    () =>
      buildMonitoringNotes(periodDetections, {
        periodLabel,
        comparison: comparison
          ? { ...comparison, previous: previousCount, current: periodCount }
          : null,
      }),
    [periodDetections, periodLabel, comparison, previousCount, periodCount],
  );

  const todayCount = statsReady ? Number(stats.detections ?? 0) : null;
  const monthCount = statsReady ? Number(stats.month_detections ?? 0) : null;
  const allTimeCount = statsReady ? Number(stats.total_detections ?? 0) : null;
  const topClass = topClasses[0] || null;

  const todayDelta =
    dateRange === 'Today' && comparison?.percent != null ? comparison : null;

  const loading = detectionsLoading && !detectionsLoaded;

  const exportCsv = async () => {
    await confirmThenRun({
      title: 'Export CSV?',
      message: `Download ${periodDetections.length} record${periodDetections.length === 1 ? '' : 's'} for ${periodLabel}.`,
      confirmLabel: 'Export CSV',
      busyTitle: 'Exporting CSV',
      busyMessage: 'Preparing the spreadsheet download.',
      busyLabel: 'Exporting…',
      successTitle: 'CSV exported',
      successMessage: `The CSV for ${periodLabel} is downloading.`,
      errorTitle: 'CSV not exported',
      work: async () => {
        const csv = buildCsv(periodDetections, comp);
        downloadBlob(`brgy-gracia-detections-${Date.now()}.csv`, csv, 'text/csv;charset=utf-8');
      },
    });
  };

  const reportHtml = () => {
    const reportNumber = nextReportNumber();
    const generatedBy = user?.name || user?.email || 'Administrator';
    const monitoringPeriod = `Paco Beach, Barangay Gracia · ${periodLabel}`;
    return {
      reportNumber,
      monitoringPeriod,
      html: buildOfficialReportHtml({
        reportNumber,
        reportType: 'Summary',
        generatedBy,
        monitoringPeriod,
        remarks: notes.observation,
        recommendations: notes.recommendation,
        stats,
        composition: comp,
        detections: periodDetections,
      }),
    };
  };

  const exportPdf = async () => {
    await confirmThenRun({
      title: 'Export PDF?',
      message: `Open the official report for ${periodLabel} so you can print or save it.`,
      confirmLabel: 'Export PDF',
      busyTitle: 'Preparing PDF',
      busyMessage: 'Opening the official report so you can print or save it.',
      busyLabel: 'Preparing…',
      successTitle: 'PDF ready',
      successMessage: 'The official report opened. Print or save it from that window.',
      errorTitle: 'PDF not exported',
      work: async () => {
        const built = reportHtml();
        await saveAndPrintReport(
          {
            report_type: 'Summary',
            monitoring_period: built.monitoringPeriod,
            remarks: notes.observation,
            recommendations: notes.recommendation,
          },
          built.html,
        );
      },
    });
  };

  const parseRecipients = (text) => [...new Set(
    String(text || '')
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  )];

  const sendReportEmail = async () => {
    if (sendingEmail) return;
    const recipients = parseRecipients(recipientText);
    if (!recipients.length) {
      setEmailError('Enter at least one recipient email address.');
      return;
    }
    setEmailError('');
    const outcome = await confirmThenRun({
      title: 'Send this report?',
      message: `Gmail will send the PDF for ${periodLabel} to ${recipients.join(', ')}.`,
      confirmLabel: 'Send PDF',
      busyTitle: 'Sending report',
      busyMessage: 'Gmail is sending the PDF. Keep this window open until it finishes.',
      busyLabel: 'Sending…',
      successTitle: 'Report sent',
      successMessage: (result) => `The PDF was emailed to ${result.count} recipient${result.count === 1 ? '' : 's'}.`,
      errorTitle: 'Email not sent',
      errorFallback: 'The report could not be sent.',
      work: async () => {
        setSendingEmail(true);
        try {
          const built = reportHtml();
          const result = await emailReport({
            recipients,
            html: built.html,
            report_number: built.reportNumber,
            monitoring_period: built.monitoringPeriod,
            message: emailMessage.trim() || DEFAULT_EMAIL_MESSAGE,
          });
          return { count: result.recipients?.length || recipients.length };
        } finally {
          setSendingEmail(false);
        }
      },
    });
    if (outcome.ok) {
      setRecipientText('');
      setEmailOpen(false);
      return;
    }
    if (outcome.error) {
      const data = outcome.error?.response?.data;
      const first = data?.errors && Object.values(data.errors).flat()[0];
      setEmailError(first || data?.message || 'The report could not be sent.');
    }
  };

  const clearFilters = () => {
    setDateRange('All Dates');
    setFromDate('');
    setToDate('');
    setRecordQuery('');
    setCameraFilter('All Cameras');
  };

  const currentWeek = weekly.find((w) => w.isCurrent) || weekly[weekly.length - 1];
  const prevWeek = weekly.length > 1 ? weekly[weekly.indexOf(currentWeek) - 1] : null;
  const weekDelta =
    currentWeek && prevWeek ? percentChange(currentWeek.value, prevWeek.value) : null;

  return (
    <div className="module-pane report-pane wa-report">
      <header className="module-head">
        <div>
          <h2 className="module-title">Reports &amp; Analytics</h2>
          <p className="module-sub">
            Recorded waste detections at Paco Beach, Barangay Gracia
            {` · ${periodLabel}`}
            {detectionsError
              ? ' · could not load records from the database'
              : detectionsLoaded
                ? ' · from saved detection records'
                : ' · loading records'}
          </p>
        </div>
      </header>

      <div className="wa-filters" role="search">
        <FilterSelect
          id="report-period"
          label="Reporting period"
          value={dateRange}
          options={DATE_OPTIONS.map((opt) => ({ value: opt, label: opt }))}
          onChange={setDateRange}
        />
        {dateRange === 'Custom Range' ? (
          <>
            <div className="filter-field">
              <label htmlFor="report-from">From</label>
              <input
                id="report-from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div className="filter-field">
              <label htmlFor="report-to">To</label>
              <input
                id="report-to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
          </>
        ) : null}
        <FilterSelect
          id="report-camera"
          label="Camera"
          value={cameraFilter}
          options={cameraOptions}
          onChange={setCameraFilter}
        />
        <div className="filter-field">
          <label htmlFor="report-waste">Waste category</label>
          <input
            id="report-waste"
            type="search"
            placeholder="Wrapper, bottle, can…"
            value={recordQuery}
            onChange={(e) => setRecordQuery(e.target.value)}
          />
        </div>
        <div className="wa-filter-actions">
          <button className="btn-ghost" type="button" onClick={clearFilters}>
            Clear
          </button>
          <span className="wa-period-count">
            {periodDetections.length} record{periodDetections.length === 1 ? '' : 's'}
          </span>
          <button className="btn-ghost" type="button" onClick={exportPdf}>
            Export PDF
          </button>
          <button className="btn-save" type="button" onClick={exportCsv}>
            Export CSV
          </button>
          <button
            className="btn-ghost"
            type="button"
            disabled={sendingEmail}
            onClick={() => { setEmailError(''); setEmailMessage(DEFAULT_EMAIL_MESSAGE); setEmailOpen(true); }}
          >
            {sendingEmail ? 'Sending…' : 'Email PDF'}
          </button>
        </div>
      </div>

      {detectionsError ? (
        <AppNotice
          type="error"
          title="Records unavailable"
          message={`${detectionsError} Charts and exports use whatever records are already loaded.`}
        />
      ) : null}

      {comparison && prevBounds ? (
        <p className={`wa-banner compare ${comparison.direction}`} role="status">
          {periodCount.toLocaleString()} recorded in {periodLabel}
          {' · '}
          {previousCount.toLocaleString()} in {formatShortDate(prevBounds.start)}–
          {formatShortDate(prevBounds.end)}
          {' · '}
          {comparison.percent != null
            ? `${comparison.label} (${comparison.direction === 'down' ? 'decreased' : comparison.direction === 'up' ? 'increased' : 'stayed the same'})`
            : comparison.label}
        </p>
      ) : null}

      <div className="wa-kpi-row">
        <KpiCard
          label="Detections today"
          value={todayCount == null ? '—' : todayCount.toLocaleString()}
          hint="Saved records dated today (database)"
          delta={todayDelta}
          color="#F5B942"
          icon="today"
        />
        <KpiCard
          label="Detections this month"
          value={monthCount == null ? '—' : monthCount.toLocaleString()}
          hint="Saved records in the current calendar month"
          color="#4DA3FF"
          icon="month"
        />
        <KpiCard
          label="All-time detections"
          value={allTimeCount == null ? '—' : allTimeCount.toLocaleString()}
          hint="All saved records, excluding ignored"
          color="#2DD4BF"
          icon="all"
        />
        <KpiCard
          label="Most detected waste"
          value={topClass ? topClass.label : '—'}
          hint={
            topClass
              ? `${topClass.count.toLocaleString()} in this view (${topClass.percent}%)`
              : 'No matching records in this view'
          }
          color="#A3E635"
          icon="top"
        />
      </div>

      <div className="wa-main-grid">
        <section className="wa-card wa-chart-card">
          <div className="wa-card-head">
            <h3>Monthly detections</h3>
            <span className="wa-card-meta">{periodLabel}</span>
          </div>
          {loading ? (
            <div className="wa-empty">Loading monthly totals…</div>
          ) : monthly.every((d) => d.total === 0) ? (
            <EmptyChart label={periodLabel} />
          ) : (
            <GroupedMonthChart data={monthly} />
          )}
          <div className="wa-legend">
            {PARENT_CATEGORIES.map((cat) => (
              <span key={cat}>
                <i style={{ background: CATEGORY_COLORS[cat] }} /> {cat}
              </span>
            ))}
          </div>
        </section>

        <section className="wa-card wa-list-card">
          <div className="wa-card-head">
            <h3>Waste category distribution</h3>
            <span className="wa-card-meta">{periodCount.toLocaleString()} items</span>
          </div>
          {loading ? (
            <div className="wa-empty">Loading distribution…</div>
          ) : periodCount === 0 ? (
            <EmptyChart label={periodLabel} />
          ) : (
            <ul className="wa-dist">
              {comp.map((row) => (
                <li key={row.label}>
                  <div className="wa-dist-label">
                    <span className="wa-list-dot" style={{ background: row.color }} />
                    <strong>{row.label}</strong>
                    <span>
                      {row.count.toLocaleString()} · {row.percent}%
                    </span>
                  </div>
                  <div className="wa-dist-track">
                    <div
                      className="wa-dist-fill"
                      style={{ width: `${row.percent}%`, background: row.color }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="wa-bottom-grid">
        <section className="wa-card wa-week-card">
          <div className="wa-card-head">
            <h3>Weekly detections</h3>
            {weekDelta?.percent != null ? (
              <span className={`wa-kpi-delta ${weekDelta.direction}`}>
                {weekDelta.label}
              </span>
            ) : null}
          </div>
          {currentWeek ? (
            <>
              <div className="wa-week-value">{currentWeek.value.toLocaleString()}</div>
              <p className="wa-week-sub">
                {currentWeek.isCurrent ? 'Current week' : 'Selected week'}{' '}
                <b>{currentWeek.label}</b>
                {prevWeek ? (
                  <>
                    {' '}
                    · previous week {prevWeek.label}: <b>{prevWeek.value.toLocaleString()}</b>
                    {weekDelta?.percent == null ? ` · ${weekDelta?.label || ''}` : ''}
                  </>
                ) : null}
              </p>
            </>
          ) : null}
          {weekly.length === 0 || weekly.every((d) => d.value === 0) ? (
            <EmptyChart label={periodLabel} />
          ) : (
            <div className="wa-week-counts" role="list">
              {weekly.map((d) => (
                <div
                  key={d.label}
                  className={`wa-week-count${d.isCurrent ? ' is-peak' : ''}`}
                  role="listitem"
                  title={`${d.label}: ${d.value} detections`}
                >
                  <span className="wa-week-count-val">{d.value}</span>
                  <div className="wa-week-count-track">
                    <div
                      className="wa-week-count-fill"
                      style={{
                        width: `${Math.round((d.value / Math.max(...weekly.map((w) => w.value), 1)) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="wa-week-count-label">{d.label}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="wa-card wa-daily-card">
          <div className="wa-card-head">
            <h3>Daily detections</h3>
            <span className="wa-card-meta">{periodLabel}</span>
          </div>
          {daily.length === 0 || daily.every((d) => d.value === 0) ? (
            <EmptyChart label={periodLabel} />
          ) : (
            <div className="wa-daily-bars" role="img" aria-label="Daily detections">
              {daily.map((d) => {
                const max = Math.max(...daily.map((x) => x.value), 1);
                return (
                  <div
                    className={`wa-daily-col${d.isToday ? ' is-peak' : ''}`}
                    key={d.key}
                  >
                    <span className="wa-daily-val">{d.value || ''}</span>
                    <div
                      className="wa-daily-bar"
                      style={{ height: `${Math.max(8, (d.value / max) * 100)}%` }}
                      title={`${d.label}: ${d.value} detections`}
                    />
                    <span className="wa-daily-day">{d.label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <section className="wa-card wa-rank-card">
        <div className="wa-card-head">
          <h3>Top 5 most detected waste categories</h3>
          <span className="wa-card-meta">{periodLabel}</span>
        </div>
        {topClasses.length === 0 ? (
          <EmptyChart label={periodLabel} />
        ) : (
          <ol className="wa-rank">
            {topClasses.map((row) => (
              <li key={row.label}>
                <span className="wa-rank-n">{row.rank}</span>
                <span className="wa-list-dot" style={{ background: row.color }} />
                <div className="wa-rank-copy">
                  <strong>{row.label}</strong>
                  <em>{row.category}</em>
                </div>
                <span className="wa-rank-count">{row.count.toLocaleString()}</span>
                <span className="wa-rank-pct">{row.percent}%</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="wa-notes" aria-label={`Observation and recommendation for ${periodLabel}`}>
        <header className="wa-notes-head">
          <span>From recorded data</span>
          <strong>{periodLabel}</strong>
          <button className="wa-link" type="button" onClick={() => setNotesOpen(true)}>
            View details
          </button>
        </header>
        <article className="wa-note">
          <h3>Observation</h3>
          <p>{notes.observation}</p>
        </article>
        <article className="wa-note">
          <h3>Recommendation</h3>
          <p>{notes.recommendation}</p>
        </article>
      </section>

      <Modal open={emailOpen} onClose={() => { if (!sendingEmail) setEmailOpen(false); }} labelledBy="report-email-title" size="sm">
        <div className="report-email">
          <div className="modal-head">
            <h3 id="report-email-title">Email this report</h3>
            <button className="modal-close" type="button" aria-label="Close" disabled={sendingEmail} onClick={() => setEmailOpen(false)}>
              ×
            </button>
          </div>
          <div className="modal-body">
            <p className="lead">
              The PDF uses the filters on screen for {periodLabel}. It is sent from the system Gmail account.
            </p>
            <div className="field">
              <label htmlFor="report-message">Message</label>
              <textarea
                id="report-message"
                rows={4}
                value={emailMessage}
                disabled={sendingEmail}
                onChange={(e) => setEmailMessage(e.target.value)}
              />
              <p className="hint">This message is filled in for every email. You can change it before sending.</p>
            </div>
            <div className="field">
              <label htmlFor="report-recipients">Recipient email addresses</label>
              <textarea
                id="report-recipients"
                rows={4}
                value={recipientText}
                disabled={sendingEmail}
                placeholder="one@example.com, two@example.com"
                onChange={(e) => setRecipientText(e.target.value)}
              />
              <p className="hint">Separate addresses with commas or new lines.</p>
            </div>
            {emailError ? <AppNotice type="error" title="Email not sent" message={emailError} /> : null}
          </div>
          <div className="modal-foot">
            <button className="btn-ghost" type="button" disabled={sendingEmail} onClick={() => setEmailOpen(false)}>
              Cancel
            </button>
            <button className="btn-save" type="button" disabled={sendingEmail} onClick={sendReportEmail}>
              {sendingEmail ? 'Sending…' : 'Send PDF'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={notesOpen} onClose={() => setNotesOpen(false)} labelledBy="report-notes-title">
        <div className="modal-head">
          <h3 id="report-notes-title">Monitoring notes · {periodLabel}</h3>
          <button className="modal-close" type="button" aria-label="Close" onClick={() => setNotesOpen(false)}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <article className="wa-note-full">
            <h4>Observation</h4>
            <p>{notes.observation}</p>
          </article>
          <article className="wa-note-full">
            <h4>Recommendation</h4>
            <p>{notes.recommendation}</p>
          </article>
        </div>
        <div className="modal-foot">
          <button className="btn-save" type="button" onClick={() => setNotesOpen(false)}>
            Close
          </button>
        </div>
      </Modal>
    </div>
  );
}
