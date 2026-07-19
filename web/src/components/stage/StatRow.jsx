import { useSettingsStore } from '../../stores/useSettingsStore';
import { MOCK_STATS } from '../../data/mock';

function StatCard({ label, value, suffix, delta }) {
  const dir = delta?.direction || 'neutral';
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        <span className="stat-num">{value}</span>
        {suffix ? <small>{suffix}</small> : null}
      </div>
      <div className={`stat-delta ${dir}`}>{delta?.text || '\u00A0'}</div>
    </div>
  );
}

export default function StatRow() {
  const stats = useSettingsStore((s) => s.stats) || MOCK_STATS;
  const deltas = { ...MOCK_STATS.deltas, ...(stats.deltas || {}) };

  const detections = stats.detections ?? MOCK_STATS.detections;
  const debrisKg = stats.debris_kg ?? MOCK_STATS.debris_kg;
  const reports = stats.reports_filed ?? MOCK_STATS.reports_filed;

  const hotspots = stats.hotspots || MOCK_STATS.hotspots;
  const hotspotValue =
    hotspots?.flagged != null
      ? hotspots.flagged
      : typeof hotspots === 'number'
        ? hotspots
        : MOCK_STATS.hotspots.flagged;
  const hotspotSuffix =
    hotspots?.total != null
      ? `of ${hotspots.total}`
      : `of ${MOCK_STATS.hotspots.total}`;

  return (
    <div className="stat-row">
      <StatCard
        label="Detections today"
        value={detections}
        delta={deltas.detections}
      />
      <StatCard
        label="Est. debris load"
        value={debrisKg}
        suffix="kg"
        delta={deltas.debris_kg}
      />
      <StatCard
        label="Hotspot sectors"
        value={hotspotValue}
        suffix={hotspotSuffix}
        delta={deltas.hotspots}
      />
      <StatCard
        label="Reports filed"
        value={reports}
        delta={deltas.reports_filed}
      />
    </div>
  );
}
