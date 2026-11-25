import { useRef, useEffect, useMemo, useState } from 'react';
import usePageVisible from '../../hooks/usePageVisible';
import SummaryCards from './SummaryCards';
import FilterBar from './FilterBar';
import SnapshotViewer from './SnapshotViewer';
import MissedDetectionReview from './MissedDetectionReview';
import TableSelectAll from '../common/TableSelectAll';
import { deleteDetection, deleteDetections, moveDetectionToReview } from '../../api/detections';
import { STATUS, statusClassOf, statusLabelOf, statusTitleOf } from '../../lib/wasteStatus';
import { confirmThenRun } from '../../stores/useNoticeStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useCameraStore } from '../../stores/useCameraStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { useFocusStore } from '../../stores/useFocusStore';
import { notice } from '../../stores/useNoticeStore';
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
  const cancelDetectionsFetch = useSettingsStore((s) => s.cancelDetectionsFetch);
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const fetchStats = useSettingsStore((s) => s.fetchStats);
  const cameras = useCameraStore((s) => s.cameras);
  // Today's Report can open this page already filtered to one waste type.
  const [filters, setFilters] = useState(() => {
    try {
      const subtype = sessionStorage.getItem('tidalwatch-detections-subtype');
      if (subtype) {
        sessionStorage.removeItem('tidalwatch-detections-subtype');
        return { ...INITIAL_FILTERS, wasteSubtype: subtype };
      }
    } catch {
      /* ignore */
    }
    return INITIAL_FILTERS;
  });
  const [viewing, setViewing] = useState(null);
  const [tab, setTab] = useState(() => (
    sessionStorage.getItem('tidalwatch-detections-tab') === 'review' ? 'review' : 'detections'
  ));
  const [busyId, setBusyId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const isAdmin = String(user?.role || '').toLowerCase() === 'admin';
  const pageVisible = usePageVisible();

  useEffect(() => {
    sessionStorage.setItem('tidalwatch-detections-tab', tab);
  }, [tab]);

  useEffect(() => {
    if (!token || tab !== 'detections') {
      if (tab === 'review') cancelDetectionsFetch();
      return undefined;
    }
    fetchDetections(50);
    fetchStats();
    if (!pageVisible) return undefined;
    // Rows refresh every 2 s, same as the Detection Log, so both stay in step.
    // Stats refresh every other tick (4 s) so the cards stay live.
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      fetchDetections(50);
      if (tick % 2 === 0) fetchStats();
    }, 2000);
    return () => clearInterval(timer);
  }, [token, pageVisible, fetchDetections, fetchStats, cancelDetectionsFetch, tab]);

  const source = useMemo(
    () =>
      (Array.isArray(apiDetections) ? apiDetections : []).filter((row) =>
        Number.isInteger(Number(row?.id)),
      ),
    [apiDetections],
  );

  const rows = useMemo(() => filterDetections(source, filters), [source, filters]);
  // Opened from a notification: show this record and flash it.
  const focusId = useFocusStore((s) => s.detectionId);
  const [flashId, setFlashId] = useState(null);
  const focusTries = useRef(0);
  useEffect(() => {
    if (!focusId) return undefined;
    if (tab !== 'detections') {
      setTab('detections');
      return undefined;
    }
    const row = document.querySelector(`[data-detection-id="${focusId}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashId(focusId);
      useFocusStore.getState().clearDetection();
      focusTries.current = 0;
      const id = setTimeout(() => setFlashId(null), 2600);
      return () => clearTimeout(id);
    }
    // Wait for the list to load; then say so if the record is not in it.
    focusTries.current += 1;
    if (focusTries.current > 3 && rows.length) {
      notice.info(`Record #${focusId}`, 'This record is not in the newest list. Use the filters to find older records.');
      useFocusStore.getState().clearDetection();
      focusTries.current = 0;
    }
    return undefined;
  }, [focusId, tab, rows]);

  const rowIds = useMemo(() => rows.map((row) => row.id).filter((id) => Number.isInteger(Number(id))), [rows]);
  const selectedCount = rowIds.filter((id) => selectedIds.has(id)).length;
  const allSelected = rowIds.length > 0 && selectedCount === rowIds.length;
  const someSelected = selectedCount > 0 && !allSelected;
  // Every row has a checkbox, the same as Detection Reviews (no header checkbox;
  // use the Select all button to pick every row).
  const selectMode = true;

  useEffect(() => {
    setSelectedIds((current) => {
      const allowed = new Set(rowIds);
      const next = new Set([...current].filter((id) => allowed.has(id)));
      if (next.size === current.size) return current;
      return next;
    });
  }, [rowIds]);

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(rowIds));
  };

  const toggleRow = (id) => {
    if (!Number.isInteger(Number(id))) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
      fetchDetections(50);
    }
    setBusyId(null);
  };

  const runBulk = async (action) => {
    const ids = rowIds.filter((id) => selectedIds.has(id));
    if (!ids.length || busyId) return;
    const deleting = action === 'delete';
    setBusyId('bulk');
    const outcome = await confirmThenRun(
      deleting
        ? {
            title: `Delete ${ids.length} detections?`,
            message: `${ids.length} records and their snapshots will be removed.`,
            confirmLabel: 'Delete selected',
            variant: 'danger',
            busyTitle: 'Deleting detections',
            busyMessage: `Removing ${ids.length} detections from saved records.`,
            busyLabel: 'Deleting…',
            successTitle: 'Detections deleted',
            successMessage: `${ids.length} detections were deleted.`,
            errorTitle: 'Detections not deleted',
            // One request for every selected row instead of one per row.
            work: () => deleteDetections(ids),
          }
        : {
            title: `Move ${ids.length} detections to review?`,
            message: `${ids.length} records will leave Waste Detections and open in Detection Reviews.`,
            confirmLabel: 'Move selected',
            variant: 'warning',
            busyTitle: 'Moving to review',
            busyMessage: `Moving ${ids.length} detections into Detection Reviews.`,
            busyLabel: 'Moving…',
            successTitle: 'Moved to review',
            successMessage: `${ids.length} detections are in Detection Reviews.`,
            errorTitle: 'Could not move detections',
            work: async () => {
              for (const id of ids) {
                await moveDetectionToReview(id);
              }
            },
          },
    );
    if (outcome.ok) {
      const gone = new Set(ids);
      useSettingsStore.setState((state) => ({
        detections: state.detections.filter((item) => !gone.has(item.id)),
      }));
      setSelectedIds(new Set());
      fetchStats();
      fetchDetections(50);
    }
    setBusyId(null);
  };

  const emptyCols = (isAdmin ? 10 : 9) - (selectMode ? 0 : 1);

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
          <div className="det-table-tools">
            <TableSelectAll
              allSelected={allSelected}
              someSelected={someSelected}
              disabled={!rowIds.length || Boolean(busyId)}
              onToggle={toggleAll}
              count={allSelected ? selectedCount : 0}
            />
            <button
              type="button"
              className="deck-btn"
              disabled={!isAdmin || selectedCount === 0 || Boolean(busyId)}
              onClick={() => runBulk('review')}
            >
              Move selected to Review
            </button>
            <button
              type="button"
              className="deck-btn"
              disabled={!isAdmin || selectedCount === 0 || Boolean(busyId)}
              onClick={() => runBulk('delete')}
            >
              Delete selected
            </button>
          </div>
        </div>
        <div className="det-table-wrap det-wrap-tall">
          <table className="det-table det-table-roomy">
            <thead>
              <tr>
                {selectMode ? <th className="det-select-col" aria-label="Select" /> : null}
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
                {isAdmin ? <th className="det-actions-col">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {!detectionsLoaded || (detectionsLoading && source.length === 0) ? (
                <tr>
                  <td colSpan={emptyCols} className="det-table-empty">
                    Loading detection records...
                  </td>
                </tr>
              ) : detectionsError && source.length === 0 ? (
                <tr>
                  <td colSpan={emptyCols} className="det-table-empty">
                    Unable to load detection records.
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={emptyCols} className="det-table-empty">
                    No detections match these filters.
                  </td>
                </tr>
              ) : null}
              {rows.map((d) => {
                const { category, subtype } = classifyWaste(d);
                const attrLabel = datasetAttributionOf(d);
                const attrTip = datasetAttributionTooltipOf(d);
                const checked = selectedIds.has(d.id);
                return (
                  <tr
                    key={d.id || `${d.class}-${d.detected_at}`}
                    data-detection-id={d.id}
                    className={`${checked ? 'is-selected' : ''}${flashId && Number(d.id) === flashId ? ' is-focus' : ''}`.trim() || undefined}
                  >
                    {selectMode ? (
                      <td className="det-select-col">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={Boolean(busyId) || !Number.isInteger(Number(d.id))}
                          aria-label={`Select detection ${d.id}`}
                          onChange={() => toggleRow(d.id)}
                        />
                      </td>
                    ) : null}
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
                    <td>
                      {d.status ? (
                        <span className={`det-status ${statusClassOf(d)}`} title={statusTitleOf(d)}>
                          {statusLabelOf(d)}
                        </span>
                      ) : (
                        '—'
                      )}
                      {d.status === STATUS.VERIFIED && d.cleaning_verified_by ? (
                        <span className="det-status-by">by {d.cleaning_verified_by}</span>
                      ) : null}
                    </td>
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
