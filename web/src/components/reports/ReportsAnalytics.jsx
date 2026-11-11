import { useMemo, useId } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore';
import {
  MOCK_COMPOSITION,
  MOCK_CHART_DAILY,
  MOCK_CHART_WEEKLY,
  MOCK_CHART_MONTHLY,
  MOCK_STATS,
} from '../../data/mock';
import { classifyWaste } from '../../lib/wasteFilters';
import { useAuthStore } from '../../stores/useAuthStore';
import {
  nextReportNumber,
  buildOfficialReportHtml,
  saveAndPrintReport,
} from '../../lib/reportForm';

const ACCENT = {
  amber: '#F5B942',
  blue: '#4DA3FF',
  teal: '#2EE6C0',
  pink: '#F472B6',
  lime: '#A3E635',
  coral: '#FF6E61',
  purple: '#C084FC',
};

const TYPE_ACCENT = {
  Plastics: ACCENT.teal,
  Papers: ACCENT.amber,
  Metals: ACCENT.blue,
  Glass: ACCENT.purple,
  Wood: ACCENT.coral,
  Other: '#94A3B8',
};

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
    `Generated,${new Date().toLocaleString()}`,
    '',
    'waste_type,classification,location,camera,confidence,count,time',
  ];
  detections.forEach((d) => {
    const { category, subtype } = classifyWaste(d);
    const conf =
      d.confidence != null
        ? Math.round(Number(d.confidence) * (d.confidence <= 1 ? 100 : 1))
        : '';
    lines.push(
      [
        `"${category}"`,
        `"${subtype}"`,
        `"${d.sector || ''}"`,
        d.camera_id || '',
        conf,
        d.count ?? '',
        d.detected_at || '',
      ].join(','),
    );
  });
  lines.push('');
  lines.push('composition_label,percent,count');
  composition.forEach((c) => {
    lines.push(`"${c.label}",${c.percent},${c.count ?? ''}`);
  });
  return lines.join('\n');
}

function pctDelta(curr, prev) {
  if (prev == null || prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
}

function hasRealSeries(series) {
  return Array.isArray(series) && series.length > 0;
}

function Sparkline({ data, color, height = 42 }) {
  const id = useId().replace(/:/g, '');
  const vals = data.map((d) => d.value);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const w = 120;
  const h = height;
  const pts = vals.map((v, i) => {
    const x = (i / Math.max(vals.length - 1, 1)) * w;
    const y = h - 4 - ((v - min) / Math.max(max - min, 1)) * (h - 10);
    return `${x},${y}`;
  });
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;

  return (
    <svg className="wa-spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <defs>
        <linearGradient id={`sg-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.45" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <filter id={`glow-${id}`}>
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path d={area} fill={`url(#sg-${id})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#glow-${id})`}
      />
    </svg>
  );
}

function KpiIcon({ name, color }) {
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
  if (name === 'users') {
    return (
      <svg {...common} style={{ color }}>
        <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
        <circle cx="9" cy="7" r="3" />
        <path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      </svg>
    );
  }
  if (name === 'revenue') {
    return (
      <svg {...common} style={{ color }}>
        <rect x="3" y="10" width="4" height="10" rx="1" />
        <rect x="10" y="6" width="4" height="14" rx="1" />
        <rect x="17" y="3" width="4" height="17" rx="1" />
      </svg>
    );
  }
  return (
    <svg {...common} style={{ color }}>
      <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function KpiCard({ label, value, delta, spark, color, icon }) {
  const up = delta >= 0;
  return (
    <article className="wa-kpi">
      <div className="wa-kpi-top">
        <span className="wa-kpi-icon" style={{ background: `${color}22`, color }}>
          <KpiIcon name={icon} color={color} />
        </span>
        <span className={`wa-kpi-delta ${up ? 'up' : 'down'}`}>
          {up ? '↑' : '↓'} {Math.abs(delta)}%
        </span>
      </div>
      <div className="wa-kpi-mid">
        <div>
          <div className="wa-kpi-value">{value}</div>
          <div className="wa-kpi-label">{label}</div>
        </div>
        <Sparkline data={spark} color={color} />
      </div>
    </article>
  );
}

function DualBarChart({ title, data, seriesA, seriesB }) {
  const max = Math.max(...data.flatMap((d) => [d.a, d.b]), 1);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(max * t));

  return (
    <section className="wa-card wa-chart-card">
      <div className="wa-card-head">
        <h3>{title}</h3>
      </div>
      <div className="wa-dual-chart" role="img" aria-label={title}>
        <div className="wa-dual-y">
          {[...ticks].reverse().map((t) => (
            <span key={t}>{t >= 1000 ? `${(t / 1000).toFixed(t % 1000 ? 1 : 0)}K` : t}</span>
          ))}
        </div>
        <div className="wa-dual-plot">
          <div className="wa-dual-grid">
            {ticks.map((t) => (
              <div key={t} className="wa-dual-gridline" />
            ))}
          </div>
          <div className="wa-dual-cols">
            {data.map((d) => (
              <div className="wa-dual-col" key={d.label}>
                <div className="wa-dual-pair">
                  <div
                    className="wa-dual-bar a"
                    style={{ height: `${Math.max(4, (d.a / max) * 100)}%` }}
                    title={`${seriesA}: ${d.a}`}
                  />
                  <div
                    className="wa-dual-bar b"
                    style={{ height: `${Math.max(4, (d.b / max) * 100)}%` }}
                    title={`${seriesB}: ${d.b}`}
                  />
                </div>
                <span className="wa-dual-x">{d.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="wa-legend">
        <span>
          <i className="a" /> {seriesA}
        </span>
        <span>
          <i className="b" /> {seriesB}
        </span>
      </div>
    </section>
  );
}

function CompositionList({ title, rows }) {
  return (
    <section className="wa-card wa-list-card">
      <div className="wa-card-head">
        <h3>{title}</h3>
      </div>
      <div className="wa-list-head">
        <span>Waste category</span>
        <span>% of all</span>
        <span>Vs avg</span>
      </div>
      <ul className="wa-list">
        {rows.map((r) => {
          const up = r.delta >= 0;
          return (
            <li key={r.label}>
              <div className="wa-list-type">
                <span
                  className="wa-list-dot"
                  style={{ background: r.color, boxShadow: `0 0 10px ${r.color}88` }}
                />
                <span>{r.label}</span>
              </div>
              <span className="wa-list-users">{r.percent}%</span>
              <span className={`wa-list-change ${up ? 'up' : 'down'}`}>
                {up ? '↑' : '↓'} {Math.abs(r.delta)} pts
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function WeeklyTrendCard({ data }) {
  const latest = data[data.length - 1] ?? { label: '—', value: 0 };
  const prev = data[data.length - 2] ?? latest;
  const delta = pctDelta(latest.value, prev.value);
  const peak = data.reduce((a, b) => (b.value > a.value ? b : a), data[0] || { label: '—', value: 0 });
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <section className="wa-card wa-week-card">
      <div className="wa-card-head">
        <h3>Weekly detections</h3>
        <span className={`wa-kpi-delta ${delta >= 0 ? 'up' : 'down'}`}>
          {delta >= 0 ? '↑' : '↓'} {Math.abs(delta)}%
        </span>
      </div>
      <div className="wa-week-value">{latest.value.toLocaleString()}</div>
      <p className="wa-week-sub">
        Latest week (<b>{latest.label}</b>)
        {prev.label !== latest.label && (
          <>
            {' '}
            · vs {prev.label}: <b>{prev.value.toLocaleString()}</b>
          </>
        )}
      </p>
      <div className="wa-week-spark-wrap">
        <Sparkline data={data} color={ACCENT.lime} height={40} />
      </div>
      <div className="wa-week-counts" role="list">
        {data.map((d) => (
          <div
            key={d.label}
            className={`wa-week-count${d.label === peak.label ? ' is-peak' : ''}`}
            role="listitem"
            title={`${d.label}: ${d.value} detections`}
          >
            <span className="wa-week-count-val">{d.value}</span>
            <div className="wa-week-count-track">
              <div
                className="wa-week-count-fill"
                style={{ width: `${Math.round((d.value / max) * 100)}%` }}
              />
            </div>
            <span className="wa-week-count-label">{d.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function ReportsAnalytics() {
  const composition = useSettingsStore((s) => s.composition);
  const detections = useSettingsStore((s) => s.detections);
  const liveDetections = useSettingsStore((s) => s.liveDetections);
  const stats = useSettingsStore((s) => s.stats) || MOCK_STATS;
  const chartTrends = useSettingsStore((s) => s.chartTrends);
  const quotas = useSettingsStore((s) => s.quotas);
  const user = useAuthStore((s) => s.user);

  const comp = composition?.length ? composition : MOCK_COMPOSITION;
  const daily = hasRealSeries(chartTrends?.daily) ? chartTrends.daily : MOCK_CHART_DAILY;
  const weekly = hasRealSeries(chartTrends?.weekly) ? chartTrends.weekly : MOCK_CHART_WEEKLY;
  const monthly = hasRealSeries(chartTrends?.monthly) ? chartTrends.monthly : MOCK_CHART_MONTHLY;
  const usingLiveCharts = Boolean(chartTrends);

  const plasticsShare = (comp.find((c) => /plastic/i.test(c.label))?.percent ?? 48) / 100;

  const monthlyDual = useMemo(
    () =>
      monthly.map((d) => ({
        label: d.label,
        a: Math.round(d.value * plasticsShare),
        b: Math.round(d.value * (1 - plasticsShare)),
      })),
    [monthly, plasticsShare],
  );

  const listRows = useMemo(() => {
    const avg = comp.reduce((s, c) => s + c.percent, 0) / Math.max(comp.length, 1);
    return comp.map((c) => ({
      label: c.label,
      percent: c.percent,
      delta: Math.round(c.percent - avg),
      color: TYPE_ACCENT[c.label] || ACCENT.teal,
    }));
  }, [comp]);

  const allDetections = useMemo(() => {
    const merged = [...(liveDetections || []), ...(detections || [])];
    return merged.length ? merged : [];
  }, [detections, liveDetections]);

  const todayCount = Number(stats.detections ?? 0);
  const monthCount = Number(stats.month_detections ?? 0);
  const allTimeCount = Number(stats.total_detections ?? 0);

  const dayDeltaFromApi = stats?.deltas?.detections?.text
    ? Number(String(stats.deltas.detections.text).replace(/[^\d.-]/g, '')) *
      (String(stats.deltas.detections.direction) === 'down' ? -1 : 1)
    : null;
  const dayDelta =
    dayDeltaFromApi != null && !Number.isNaN(dayDeltaFromApi)
      ? Math.round(dayDeltaFromApi)
      : pctDelta(daily[daily.length - 1]?.value ?? 0, daily[daily.length - 2]?.value ?? 0);
  const monthDelta = pctDelta(
    monthly[monthly.length - 1]?.value ?? 0,
    monthly[monthly.length - 2]?.value ?? 0,
  );
  const allTimeDelta = monthDelta;

  const exportCsv = () => {
    const csv = buildCsv(allDetections.length ? allDetections : detections || [], comp);
    downloadBlob(`brgy-gracia-detections-${Date.now()}.csv`, csv, 'text/csv;charset=utf-8');
  };

  const exportPdf = () => {
    const reportNumber = nextReportNumber();
    const generatedBy = user?.name || user?.email || 'Administrator';
    const quota = (quotas || [])[0] || null;
    const now = new Date();
    const monitoringPeriod = `Paco Beach, Barangay Gracia · ${now.toLocaleDateString('en-PH', {
      month: 'long',
      year: 'numeric',
    })}`;
    const html = buildOfficialReportHtml({
      reportNumber,
      reportType: 'Summary',
      generatedBy,
      monitoringPeriod,
      stats,
      composition: comp,
      detections: allDetections.length ? allDetections : detections || [],
      quota,
    });
    saveAndPrintReport(
      {
        report_type: 'Summary',
        monitoring_period: monitoringPeriod,
        remarks:
          'System-generated coastal waste monitoring report for Barangay Gracia, Paco Beach.',
        recommendations:
          quota?.status === 'reached'
            ? quota.cleanup_recommendation
            : 'Continue scheduled coastal monitoring. Conduct cleanup when the configured waste quota is reached.',
      },
      html,
    );
  };

  return (
    <div className="module-pane report-pane wa-report">
      <header className="module-head">
        <div>
          <h2 className="module-title">Reports &amp; Analytics</h2>
          <p className="module-sub">
            Live detection trends for Brgy. Gracia
            {usingLiveCharts ? ' · updated from database' : ' · sample charts until API connects'}
          </p>
        </div>
        <div className="module-actions">
          <button className="btn-ghost" type="button" onClick={exportPdf}>
            Export PDF
          </button>
          <button className="btn-save" type="button" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </header>

      <div className="wa-kpi-row">
        <KpiCard
          label="Detected today"
          value={todayCount.toLocaleString()}
          delta={dayDelta}
          spark={daily}
          color={ACCENT.amber}
          icon="users"
        />
        <KpiCard
          label="Detected this month"
          value={monthCount.toLocaleString()}
          delta={monthDelta}
          spark={monthly}
          color={ACCENT.blue}
          icon="revenue"
        />
        <KpiCard
          label="All-time total"
          value={allTimeCount.toLocaleString()}
          delta={allTimeDelta}
          spark={weekly}
          color={ACCENT.teal}
          icon="rate"
        />
      </div>

      <div className="wa-main-grid">
        <DualBarChart
          title="Monthly detections"
          data={monthlyDual}
          seriesA="Plastics"
          seriesB="Other waste"
        />
        <CompositionList title="Waste by type · 30d" rows={listRows} />
      </div>

      <div className="wa-bottom-grid">
        <WeeklyTrendCard data={weekly} />
        <section className="wa-card wa-daily-card">
          <div className="wa-card-head">
            <h3>Daily detections</h3>
          </div>
          <div className="wa-daily-bars" role="img" aria-label="Daily detections">
            {(() => {
              const max = Math.max(...daily.map((d) => d.value), 1);
              const peak = daily.reduce((a, b) => (b.value > a.value ? b : a), daily[0]);
              return daily.map((d) => (
                <div
                  className={`wa-daily-col${d.label === peak.label ? ' is-peak' : ''}`}
                  key={d.label}
                >
                  <span className="wa-daily-val">{d.value}</span>
                  <div
                    className="wa-daily-bar"
                    style={{ height: `${Math.max(8, (d.value / max) * 100)}%` }}
                    title={`${d.label}: ${d.value} detections`}
                  />
                  <span className="wa-daily-day">{d.label}</span>
                </div>
              ));
            })()}
          </div>
        </section>
      </div>
    </div>
  );
}
