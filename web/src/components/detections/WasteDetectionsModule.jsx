import { useEffect, useMemo, useState } from 'react';
import SummaryCards from './SummaryCards';
import FilterBar from './FilterBar';
import SnapshotViewer from './SnapshotViewer';
import MissedDetectionReview from './MissedDetectionReview';
import { deleteDetection, moveDetectionToReview } from '../../api/detections';
import { confirmThenRun } from '../../stores/useNoticeStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useCameraStore } from '../../stores/useCameraStore';
import { useAuthStore } from '../../stores/useAuthStore';
import {
  classifyWaste,
  filterDetections,
  locationOf,
} from '../../lib/wasteFilters';
import {
  datasetAttributionOf,
  datasetAttributionTooltipOf,
  detectionSourceOf,
  trainingDatasetLabelOf,
} from '../../lib/datasetSource';

const INITIAL_FILTERS = {
  dateRange: 'All Dates',
  wasteType: 'All Categories',
  wasteSubtype: 'All Classifications',
  location: 'All Locations',
  camera: 'All Cameras',
  datasetSource: 'All Sources',
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
  const detectionsLoading = useSettingsStore((s) => s.detectionsLoading);
  const detectionsError = useSettingsStore((s) => s.detectionsError);
  const detectionsLoaded = useSettingsStore((s) => s.detectionsLoaded);
  const fetchDetections = useSettingsStore((s) => s.fetchDetections);
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const fetchStats = useSettingsStore((s) => s.fetchStats);
  const cameras = useCameraStore((s) => s.cameras);
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [viewing, setViewing] = useState(null);
  const [tab, setTab] = useState('detections');
  const [busyId, setBusyId] = useState(null);
  const isAdmin = String(user?.role || '').toLowerCase() === 'admin';

  useEffect(() => {
    if (!token) return undefined;
    fetchDetections(50);
    return undefined;
  }, [token, fetchDetections]);

  const source = useMemo(
    () =>
      (Array.isArray(apiDetections) ? apiDetections : []).filter((row) =>
        Number.isInteger(Number(row?.id)),
      ),
    [apiDetections],
  );

  const rows = useMemo(() => filterDetections(source, filters), [source, filters]);

  const runAction = async (action, row) => {
    if (!row || busyId) return;
    const deleting = action === 'delete';
    setBusyId(row.id);
    const outcome = await confirmThenRun(
      deleting
        ? {
            title: 'Delete this detection?',
            message: `Detection #${row.id} and its snapshot will be removed. Other records stay.`,
            confirmLabel: 'Delete',
            variant: 'danger',
            busyTitle: 'Deleting detection',
            busyMessage: `Removing detection #${row.id} from saved records.`,
            busyLabel: 'Deleting…',
            successTitle: 'Detection deleted',
            successMessage: `Detection #${row.id} was deleted.`,
            errorTitle: 'Detection not deleted',
            work: () => deleteDetection(row.id),
          }
        : {
            title: 'Move this detection to review?',
            message: `Detection #${row.id} will leave Waste Detections and open in Detection Reviews so it can be labeled for training.`,
            confirmLabel: 'Move to Review',
            variant: 'warning',
            busyTitle: 'Moving to review',
            busyMessage: `Moving detection #${row.id} into Detection Reviews.`,
            busyLabel: 'Moving…',
            successTitle: 'Moved to review',
            successMessage: `Detection #${row.id} is in Detection Reviews.`,
            errorTitle: 'Could not move detection',
            work: () => moveDetectionToReview(row.id),
          },
    );
    if (outcome.ok) {
      useSettingsStore.setState((state) => ({
        detections: state.detections.filter((item) => item.id !== row.id),
      }));
      fetchStats();
    }
    setBusyId(null);
  };

  return (
    <div className="module-pane">
      <div className="module-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'detections'}
          className={tab === 'detections' ? 'active' : ''}
          onClick={() => setTab('detections')}
        >
          Waste Detections
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'review'}
          className={tab === 'review' ? 'active' : ''}
          onClick={() => setTab('review')}
        >
          Detection Reviews
        </button>
      </div>
      {tab === 'review' ? <MissedDetectionReview cameras={cameras} detections={source} /> : null}
      {tab === 'detections' ? (
      <>
      <header className="module-head">
        <div>
          <h2 className="module-title">Waste Detections</h2>
          <p className="module-sub">
            Browse and filter coastal waste detections across stations. Camera /
            Detection Source is the live stream; Dataset Source is training
            attribution (Local 1 + Local 2 were merged — live predictions are not
            attributed to either subset).
          </p>
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
                <th>ID</th>
                <th>Date / Time</th>
                <th>Snapshot</th>
                <th>Waste category</th>
                <th>Confidence</th>
                <th title="Which camera/stream captured this frame">
                  Camera / Detection Source
                </th>
                <th title="Training-dataset attribution. Live YOLO uses a merged Local 1+Local 2 model — predictions are not attributed to either subset.">
                  Dataset Source
                </th>
                <th>Status</th>
                {isAdmin ? <th>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {!detectionsLoaded || (detectionsLoading && source.length === 0) ? (
                <tr>
                  <td colSpan={isAdmin ? 9 : 8} className="det-table-empty">
                    Loading detection records...
                  </td>
                </tr>
              ) : detectionsError && source.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 9 : 8} className="det-table-empty">
                    Unable to load detection records.
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 9 : 8} className="det-table-empty">
                    No detections match these filters.
                  </td>
                </tr>
              ) : null}
              {rows.map((d) => {
                const { category, subtype } = classifyWaste(d);
                const attrLabel = datasetAttributionOf(d);
                const attrTip = datasetAttributionTooltipOf(d);
                return (
                  <tr key={d.id || `${d.class}-${d.detected_at}`}>
                    <td>{d.id ?? '—'}</td>
                    <td>{formatDetectedAt(d)}</td>
                    <td>
                      <button
                        type="button"
                        className="det-snap-btn"
                        title="View snapshot"
                        aria-label={`View snapshot of ${subtype}`}
                        onClick={() => setViewing(d)}
                      >
                        {d.snapshot_url ? (
                          <img src={d.snapshot_url} alt="" />
                        ) : (
                          <EyeIcon />
                        )}
                      </button>
                    </td>
                    <td>
                      <span className="waste-type-cell">
                        <span className="waste-type-stack">
                          <span className="waste-cat">{category}</span>
                          <span className="waste-sub">
                            {subtype}
                            {d.status ? ` · ${d.status}` : ''}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td>
                      {d.confidence != null
                        ? `${Math.round(Number(d.confidence) * (d.confidence <= 1 ? 100 : 1))}%`
                        : '—'}
                    </td>
                    <td title="Live camera/stream that captured the frame">
                      {detectionSourceOf(d)}
                      {locationOf(d) ? (
                        <span className="waste-sub" style={{ display: 'block', opacity: 0.75 }}>
                          {locationOf(d)}
                        </span>
                      ) : null}
                    </td>
                    <td title={attrTip}>
                      <span className="waste-type-stack">
                        <span className="waste-cat">{attrLabel}</span>
                        <span className="waste-sub">{trainingDatasetLabelOf(d)}</span>
                      </span>
                    </td>
                    <td>{d.status || '—'}</td>
                    {isAdmin ? (
                      <td className="det-row-actions">
                        <div className="det-row-actions-inner">
                          <button
                            type="button"
                            className="deck-btn"
                            disabled={busyId === d.id}
                            onClick={() => runAction('review', d)}
                          >
                            Move to Review
                          </button>
                          <button
                            type="button"
                            className="deck-btn"
                            disabled={busyId === d.id}
                            onClick={() => runAction('delete', d)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <SnapshotViewer detection={viewing} onClose={() => setViewing(null)} />
      </>
      ) : null}
    </div>
  );
}
