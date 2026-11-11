import { useSettingsStore } from '../../stores/useSettingsStore';
import { MOCK_STATS } from '../../data/mock';

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
  const stats = useSettingsStore((s) => s.stats) || MOCK_STATS;

  const total = stats.total_detections ?? MOCK_STATS.total_detections;
  const today = stats.detections ?? MOCK_STATS.detections;
  const month = stats.month_detections ?? MOCK_STATS.month_detections;
  const avgConf = stats.avg_confidence ?? MOCK_STATS.avg_confidence;

  return (
    <div className="stat-row">
      <StatCard label="Total Detections" value={formatNum(total)} />
      <StatCard label="Today's Detections" value={formatNum(today)} />
      <StatCard label="This Month" value={formatNum(month)} />
      <StatCard
        label="Average Confidence"
        value={avgConf != null ? Number(avgConf).toFixed(1) : '—'}
        suffix="%"
      />
    </div>
  );
}
