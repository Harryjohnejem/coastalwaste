import { useSettingsStore } from '../../stores/useSettingsStore';

function formatNum(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US');
}

function StatCard({ label, value, suffix }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        <span className="stat-num">{value}</span>
        {suffix ? <small>{suffix}</small> : null}
      </div>
    </div>
  );
}

export default function SummaryCards() {
  const stats = useSettingsStore((s) => s.stats);
  const ready = useSettingsStore((s) => s.statsReady);

  const show = (value) => (ready ? formatNum(value ?? 0) : '—');

  return (
    <div className="stat-row">
      <StatCard label="Total Detections" value={show(stats?.total_detections)} />
      <StatCard label="Today's Detections" value={show(stats?.detections)} />
      <StatCard label="Still Present" value={show(stats?.present)} />
      <StatCard label="No Longer Visible" value={show(stats?.no_longer_visible)} />
      <StatCard label="Cleaning Verified" value={show(stats?.cleaning_verified)} />
    </div>
  );
}
