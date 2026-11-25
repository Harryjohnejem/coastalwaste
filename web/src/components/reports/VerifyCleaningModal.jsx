import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '../common/Modal';
import { listDetections, verifyCleaning } from '../../api/detections';
import { confirmThenRun } from '../../stores/useNoticeStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { STATUS } from '../../lib/wasteStatus';

const REFRESH_MS = 5000;

/**
 * Verify cleaning from the Main Dashboard: lists the records that left the
 * camera view (No Longer Visible, inferred) so the Barangay Sanitary Inspector
 * or an administrator can confirm the waste was physically collected.
 */
export default function VerifyCleaningModal({ open, onClose, onVerified }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await listDetections(200, { status: STATUS.NOT_VISIBLE });
      const list = Array.isArray(data) ? data : data?.data || [];
      setRows(list);
      setError('');
      // Drop selections that are no longer in the list.
      setSelected((prev) => {
        const ids = new Set(list.map((r) => Number(r.id)));
        const next = new Set([...prev].filter((id) => ids.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch {
      setError('Could not load the records. Try again.');
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    setRows(null);
    setSelected(new Set());
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [open, load]);

  const all = useMemo(() => (rows || []).map((r) => Number(r.id)), [rows]);
  const allChecked = all.length > 0 && all.every((id) => selected.has(id));

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(all));

  const verify = async () => {
    const ids = [...selected];
    if (!ids.length || busy) return;
    setBusy(true);
    const outcome = await confirmThenRun({
      title: ids.length === 1 ? 'Verify cleaning?' : `Verify cleaning of ${ids.length} records?`,
      message: 'Confirm only after the waste was physically collected or cleaned on site. Your name and the date and time are recorded.',
      confirmLabel: 'Verify cleaning',
      variant: 'info',
      busyTitle: 'Verifying cleaning',
      busyMessage: 'Saving the verification.',
      busyLabel: 'Saving…',
      successTitle: 'Cleaning verified',
      successMessage: (r) => `${(r?.verified || []).length} record${(r?.verified || []).length === 1 ? '' : 's'} marked Cleaning Verified by ${r?.verified_by || 'you'}.`,
      errorTitle: 'Cleaning not verified',
      work: () => verifyCleaning(ids),
    });
    setBusy(false);
    if (outcome.ok) {
      setSelected(new Set());
      const done = new Set((outcome.result?.verified || []).map(Number));
      useSettingsStore.setState((state) => ({
        detections: (state.detections || []).map((item) => (done.has(Number(item.id))
          ? {
            ...item,
            status: STATUS.VERIFIED,
            status_label: 'Cleaning Verified',
            cleaning_verified_by: outcome.result?.verified_by,
            cleaning_verified_at: outcome.result?.verified_at,
          }
          : item)),
      }));
      useSettingsStore.getState().fetchStats?.();
      onVerified?.();
      load();
    }
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="vc-title">
      <div className="vc-modal">
        <div className="modal-head">
          <h3 id="vc-title">Verify cleaning</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="vc-body">
          <p className="vc-lead">
            These records left the camera view (<b>No Longer Visible</b>, inferred). Check the site, then select the
            waste that was physically collected and press <b>Verify cleaning</b>. Your name and the time are recorded.
          </p>
          {error ? <p className="vc-msg is-error">{error}</p> : null}
          {rows === null ? (
            <p className="vc-msg">Loading the records…</p>
          ) : rows.length === 0 ? (
            <p className="vc-msg">Nothing to verify. No record is waiting for a cleaning check.</p>
          ) : (
            <div className="vc-scroll">
              <table className="vc-table">
                <thead>
                  <tr>
                    <th className="vc-check">
                      <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all" />
                    </th>
                    <th>ID</th>
                    <th>Date / time</th>
                    <th>Snapshot</th>
                    <th>Waste</th>
                    <th>Camera</th>
                    <th>Left the view</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const id = Number(r.id);
                    return (
                      <tr key={id} className={selected.has(id) ? 'is-selected' : ''} onClick={() => toggle(id)}>
                        <td className="vc-check" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} aria-label={`Select record ${id}`} />
                        </td>
                        <td>{id}</td>
                        <td>{r.detected_at || '—'}</td>
                        <td>
                          {r.snapshot_url ? <img src={r.snapshot_url} alt="" loading="lazy" className="vc-thumb" /> : <span className="vc-muted">—</span>}
                        </td>
                        <td>
                          <b>{r.waste_category || '—'}</b>
                          <div className="vc-muted">{r.class || ''}</div>
                        </td>
                        <td>{r.camera_id || '—'}</td>
                        <td className="vc-muted">{r.removed_at || r.last_seen_at || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="modal-foot vc-foot">
          <span className="vc-muted">
            {rows ? `${rows.length >= 200 ? 'Newest 200 shown' : `${rows.length} waiting`} · ${selected.size} selected` : ''}
          </span>
          <div className="vc-actions">
            <button type="button" className="deck-btn" onClick={onClose}>Close</button>
            <button type="button" className="deck-btn primary" disabled={!selected.size || busy} onClick={verify}>
              Verify cleaning{selected.size ? ` (${selected.size})` : ''}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
