import { useEffect, useState } from 'react';
import Modal from '../common/Modal';
import { classifyWaste, locationOf } from '../../lib/wasteFilters';
import { confidenceLabel } from '../../lib/reportAnalytics';

function snapshotUrl(detection) {
  return detection?.snapshot_url || detection?.image_url || detection?.images?.[0]?.url || '';
}

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

function EmptyFrame() {
  return (
    <div className="snap-viewer-empty" role="img" aria-label="No snapshot recorded">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="8.5" cy="10" r="1.4" />
        <path d="M21 16l-5.2-5.2a1.5 1.5 0 00-2.2 0L6 18" />
      </svg>
      <strong>No image available</strong>
      <span>This detection has no captured image on file.</span>
    </div>
  );
}

export default function SnapshotViewer({ detection, onClose }) {
  const open = Boolean(detection);
  const url = snapshotUrl(detection);
  const [broken, setBroken] = useState(false);
  const showImage = Boolean(url) && !broken;
  const { category, subtype } = detection
    ? classifyWaste(detection)
    : { category: '', subtype: '' };

  useEffect(() => {
    setBroken(false);
  }, [url, detection]);

  if (!detection) return null;

  return (
    <Modal open={open} onClose={onClose} labelledBy="snap-viewer-title" size="sm">
      <div className="modal-head">
        <h3 id="snap-viewer-title">
          Snapshot · <span>{category || 'Detection'}</span>
        </h3>
        <button className="modal-close" type="button" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="modal-body">
        <div className="tab-panes snap-viewer-body">
          {showImage ? (
            <img
              className="snap-viewer-img"
              src={url}
              alt={detection.snapshot_name || 'Detection snapshot'}
              onError={() => setBroken(true)}
            />
          ) : (
            <EmptyFrame />
          )}
          <dl className="snap-viewer-meta">
            <div>
              <dt>Waste category</dt>
              <dd>{category || '—'}</dd>
            </div>
            <div>
              <dt>Classification</dt>
              <dd>{subtype || '—'}</dd>
            </div>
            <div>
              <dt>Date / Time</dt>
              <dd>{formatDetectedAt(detection)}</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>{detection ? locationOf(detection) : '—'}</dd>
            </div>
            <div>
              <dt title="Which camera/stream captured this frame">
                Camera / Detection Source
              </dt>
              <dd>{detection?.detection_source || detection?.camera_id || '—'}</dd>
            </div>
            <div>
              <dt title="Training-dataset attribution (Local 1 + Local 2 were merged into one model)">
                Dataset Source
              </dt>
              <dd title={detection?.dataset_attribution_tooltip || undefined}>
                {detection?.dataset_attribution_label || 'Unknown / Not Attributable'}
              </dd>
            </div>
            <div>
              <dt>Training dataset</dt>
              <dd>
                {detection?.training_dataset_label ||
                  detection?.training_dataset ||
                  'Unknown / Not recorded'}
              </dd>
            </div>
            <div>
              <dt title="Detector confidence for this saved record, not overall model accuracy">
                Confidence score
              </dt>
              <dd>{confidenceLabel(detection?.confidence) || '—'}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{detection?.status || '—'}</dd>
            </div>
            <div>
              <dt>File</dt>
              <dd>{detection?.snapshot_name || (showImage ? 'snapshot.png' : 'No image file')}</dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="modal-foot">
        {showImage ? (
          <a className="btn-ghost" href={url} download={detection?.snapshot_name || 'snapshot.png'}>
            Download
          </a>
        ) : (
          <span className="btn-ghost snap-download-disabled">Download unavailable</span>
        )}
        <button className="btn-save" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
