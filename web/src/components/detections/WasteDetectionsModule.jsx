import { useMemo, useState } from 'react';
import SummaryCards from './SummaryCards';
import FilterBar from './FilterBar';
import SnapshotViewer from './SnapshotViewer';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useCameraStore } from '../../stores/useCameraStore';
import { MOCK_DETECTIONS } from '../../data/mock';
import {
  classifyWaste,
  filterDetections,
  locationOf,
} from '../../lib/wasteFilters';

const INITIAL_FILTERS = {
  dateRange: 'All Dates',
  wasteType: 'All Categories',
  wasteSubtype: 'All Classifications',
  location: 'All Locations',
  camera: 'All Cameras',
  search: '',
  from: '',
  to: '',
};

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Show date beside time (e.g. 2026-07-25 14:32:08). */
function formatDetectedAt(d) {
  const iso = d?.detected_at_iso;
  if (iso) {
    const dt = new Date(iso);
    if (!Number.isNaN(dt.getTime())) {
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const day = String(dt.getDate()).padStart(2, '0');
      const h = String(dt.getHours()).padStart(2, '0');
      const min = String(dt.getMinutes()).padStart(2, '0');
      const s = String(dt.getSeconds()).padStart(2, '0');
      return `${y}-${m}-${day} ${h}:${min}:${s}`;
    }
  }
  return d?.detected_at || '—';
}

export default function WasteDetectionsModule() {
  const apiDetections = useSettingsStore((s) => s.detections);
  const liveDetections = useSettingsStore((s) => s.liveDetections);
  const cameras = useCameraStore((s) => s.cameras);
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [viewing, setViewing] = useState(null);

  const source = useMemo(() => {
    const merged = [...(liveDetections || []), ...(apiDetections || [])];
    if (merged.length === 0) return MOCK_DETECTIONS;
    const seen = new Set();
    return merged.filter((d) => {
      const key = d.id || `${d.class}-${d.detected_at}-${d.camera_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [apiDetections, liveDetections]);

  const rows = useMemo(() => filterDetections(source, filters), [source, filters]);

  return (
    <div className="module-pane">
      <header className="module-head">
        <div>
          <h2 className="module-title">Waste Detections</h2>
          <p className="module-sub">Browse and filter coastal waste detections across stations.</p>
        </div>
      </header>

      <SummaryCards />
      <FilterBar
        filters={filters}
        onChange={setFilters}
        cameras={cameras}
        detections={source}
      />

      <section className="panel det-table-panel">
        <div className="panel-head">
          <span className="panel-title">
            Results · <b>{rows.length}</b>
          </span>
        </div>
        <div className="det-table-wrap">
          <table className="det-table">
            <thead>
              <tr>
                <th>Date / Time</th>
                <th>Waste category</th>
                <th>Location</th>
                <th>Camera</th>
                <th>Confidence</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="det-table-empty">
                    No detections match these filters.
                  </td>
                </tr>
              )}
              {rows.map((d) => {
                const { category, subtype } = classifyWaste(d);
                return (
                  <tr key={d.id || `${d.class}-${d.detected_at}`}>
                    <td>{formatDetectedAt(d)}</td>
                    <td>
                      <span className="waste-type-cell">
                        <button
                          type="button"
                          className="view-snap-btn"
                          title="View snapshot"
                          aria-label={`View snapshot of ${subtype}`}
                          onClick={() => setViewing(d)}
                        >
                          <EyeIcon />
                        </button>
                        <span className="waste-type-stack">
                          <span className="waste-cat">{category}</span>
                          <span className="waste-sub">{subtype}</span>
                        </span>
                      </span>
                    </td>
                    <td>{locationOf(d)}</td>
                    <td>{d.camera_id || '—'}</td>
                    <td>
                      {d.confidence != null
                        ? `${Math.round(Number(d.confidence) * (d.confidence <= 1 ? 100 : 1))}%`
                        : '—'}
                    </td>
                    <td>{d.count ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <SnapshotViewer detection={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
