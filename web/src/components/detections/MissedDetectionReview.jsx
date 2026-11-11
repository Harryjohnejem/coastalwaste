import { useCallback, useEffect, useRef, useState } from 'react';
import { REVIEW_POLL_MS, WASTE_CLASSES } from '../../constants';
import usePageVisible from '../../hooks/usePageVisible';
import { useAuthStore } from '../../stores/useAuthStore';
import client from '../../api/client';
import FilterSelect from '../common/FilterSelect';
import Modal from '../common/Modal';
import {
  deleteMissedDetection,
  exportApprovedDataset,
  listMissedDetections,
  reviewMissedDetection,
  saveMissedAnnotations,
} from '../../api/missedDetections';
import {
  approveTrainingDeployment,
  deployTrainingJob,
  evaluateTrainingJob,
  listTrainingJobs,
  rejectTrainingJob,
  retryTrainingJob,
  rollbackTrainingJob,
  startTrainingJob,
} from '../../api/trainingJobs';
import { acknowledgeAction, actionErrorMessage, confirmThenRun } from '../../stores/useNoticeStore';

const EMPTY_COUNTS = {
  pending: null,
  verified: null,
  approved: null,
  rejected: null,
  exported: null,
  training_eligible: null,
};

const TRAIN_STEPS = [
  { id: 'preparing', label: 'Preparing Dataset' },
  { id: 'uploading', label: 'Uploading' },
  { id: 'creating_version', label: 'Creating Version' },
  { id: 'training', label: 'Training' },
  { id: 'done', label: 'Completed / Failed' },
];

const ACTIVE_JOB = ['preparing', 'uploading', 'creating_version', 'training'];
const TERMINAL_JOB = [
  'completed',
  'failed',
  'awaiting_evaluation',
  'approved_for_deployment',
  'deployed',
  'rejected',
];

function statusLabel(status) {
  if (status === 'pending') return 'Pending Review';
  if (status === 'verified') return 'Verified';
  if (status === 'approved') return 'Approved';
  if (status === 'rejected') return 'Rejected';
  if (status === 'exported') return 'Exported';
  return '—';
}

function formatWhen(iso) {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function formatConfidence(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  return `${Math.round((n > 1 ? n : n * 100))}%`;
}

function trainingEligibility(row) {
  if (!row) return { key: 'wait', label: '—', reason: '' };
  if (row.status === 'exported' || row.training_job_id) {
    return {
      key: 'used',
      label: 'Used in a training job',
      reason: 'Already exported or assigned to a training job. It stays in this list.',
    };
  }
  if (row.status === 'approved' && row.include_in_export) {
    return {
      key: 'eligible',
      label: 'Included in training',
      reason: 'Approved and queued for the next Roboflow / ZIP export.',
    };
  }
  if (row.status === 'approved') {
    return {
      key: 'held',
      label: 'Approved · not in training',
      reason: 'Approved, but held out of the training pool until you include it.',
    };
  }
  if (row.status === 'rejected') {
    return {
      key: 'no',
      label: 'Not eligible',
      reason: 'Rejected reviews stay out of the training dataset.',
    };
  }
  if (row.status === 'verified') {
    return {
      key: 'wait',
      label: 'Needs approval',
      reason: 'Verified. Approve the review before it can enter training.',
    };
  }
  return {
    key: 'wait',
    label: 'Needs review',
    reason: 'Correct the class and box, then approve before training.',
  };
}

function trainStepState(status, stepId) {
  if (!status) return 'idle';
  if (stepId === 'done') {
    if (status === 'failed') return 'failed';
    if (TERMINAL_JOB.includes(status)) return 'current';
    return 'idle';
  }
  const order = ACTIVE_JOB;
  const current = order.indexOf(status);
  const idx = order.indexOf(stepId);
  if (TERMINAL_JOB.includes(status) && status !== 'failed') return 'done';
  if (status === 'failed') {
    return idx <= Math.max(current, 0) ? 'done' : 'idle';
  }
  if (current === -1) return 'idle';
  if (idx < current) return 'done';
  if (idx === current) return 'current';
  return 'idle';
}

function StatCard({ label, value, hint, active, onClick }) {
  return (
    <button
      className={`stat${active ? ' is-active' : ''}`}
      type="button"
      onClick={onClick}
    >
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        <span className="stat-num">{value == null ? '—' : Number(value).toLocaleString('en-US')}</span>
      </div>
      {hint ? <div className="stat-delta">{hint}</div> : null}
    </button>
  );
}

function ReviewSkeletonRows() {
  return Array.from({ length: 5 }, (_, index) => (
    <tr key={`skel-${index}`} className="review-skel">
      <td colSpan={8}><div className="review-skel-bar" /></td>
    </tr>
  ));
}

export default function MissedDetectionReview({ cameras = [] }) {
  const pageVisible = usePageVisible();
  const user = useAuthStore((s) => s.user);
  const setAuth = useAuthStore((s) => s.setAuth);
  const isAdmin = String(user?.role || '').toLowerCase() === 'admin';
  const [reports, setReports] = useState([]);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [meta, setMeta] = useState({ page: 1, per_page: 10, total: 0, last_page: 1 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    status: '',
    camera_id: '',
    class_name: '',
    from: '',
    to: '',
    q: '',
    confidence: '',
  });
  const [searchInput, setSearchInput] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [boxes, setBoxes] = useState([]);
  const [drawClass, setDrawClass] = useState(WASTE_CLASSES[0]);
  const [zoom, setZoom] = useState(1);
  const [busyAction, setBusyAction] = useState(null);
  const [training, setTraining] = useState(null);
  const [evalNotes, setEvalNotes] = useState('');
  const imageRef = useRef(null);
  const dragRef = useRef(null);
  const loadAbortRef = useRef(null);
  const busy = Boolean(busyAction);

  const realCameras = (cameras || []).filter((cam) => /^CAM-\d+$/i.test(String(cam.id || '')));

  useEffect(() => {
    if (!user || user.role) return undefined;
    let cancelled = false;
    client.get('/user').then(({ data }) => {
      if (cancelled || !data?.role) return;
      const token = useAuthStore.getState().token;
      if (token) setAuth(token, { ...user, ...data });
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user, setAuth]);

  const load = useCallback(async ({ silent } = {}) => {
    if (!silent) setLoading(true);
    if (!silent) setError('');
    loadAbortRef.current?.abort?.();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    try {
      const params = { page, per_page: 10 };
      if (filters.status) params.status = filters.status;
      if (filters.camera_id) params.camera_id = filters.camera_id;
      if (filters.class_name) params.class_name = filters.class_name;
      if (filters.from) params.from = filters.from;
      if (filters.to) params.to = filters.to;
      if (filters.q.trim()) params.q = filters.q.trim();
      if (filters.confidence === 'lt60') params.max_confidence = 0.6;
      if (filters.confidence === '60-80') {
        params.min_confidence = 0.6;
        params.max_confidence = 0.8;
      }
      if (filters.confidence === 'gte80') params.min_confidence = 0.8;
      const payload = await listMissedDetections(params, { signal: controller.signal });
      setReports(Array.isArray(payload?.data) ? payload.data : []);
      setCounts({ ...EMPTY_COUNTS, ...(payload?.counts || {}) });
      setMeta(payload?.meta || { page: 1, per_page: 10, total: 0, last_page: 1 });
      setError('');
    } catch (err) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      const msg = err?.response?.data?.message || 'Could not load detection reviews.';
      setError(msg);
      if (!silent) {
        setReports([]);
      }
    } finally {
      if (loadAbortRef.current === controller && !silent) setLoading(false);
    }
  }, [filters, page]);

  const loadTraining = useCallback(async ({ validate = false } = {}) => {
    if (!isAdmin) return null;
    try {
      const payload = await listTrainingJobs(validate ? { validate: 1 } : {});
      setTraining(payload);
      return payload;
    } catch {
      return null;
    }
  }, [isAdmin]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((current) => (current.q === searchInput ? current : { ...current, q: searchInput }));
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    load();
    loadTraining();
    return () => {
      loadAbortRef.current?.abort?.();
    };
  }, [load, loadTraining]);

  useEffect(() => {
    if (!pageVisible) return undefined;
    let running = false;
    const timer = setInterval(() => {
      if (running || busyAction) return;
      running = true;
      const jobs = [load({ silent: true })];
      const status = training?.latest?.status;
      const jobActive = ACTIVE_JOB.includes(status);
      if (isAdmin && jobActive) jobs.push(loadTraining());
      Promise.all(jobs).finally(() => {
        running = false;
      });
    }, REVIEW_POLL_MS);
    return () => clearInterval(timer);
  }, [load, loadTraining, pageVisible, isAdmin, training?.latest?.status, busyAction]);

  const selected = reports.find((row) => row.id === selectedId) || null;
  const editable = selected && (selected.status === 'pending' || selected.status === 'verified');
  const selectedElig = trainingEligibility(selected);

  useEffect(() => {
    const saved = selected?.annotations || [];
    if (saved.length) {
      setBoxes(saved.map((box) => ({
        ...box,
        x: Number(box.x),
        y: Number(box.y),
        width: Number(box.width),
        height: Number(box.height),
      })));
    } else {
      const source = (selected?.model_boxes || []).find((box) => WASTE_CLASSES.includes(box.class_name))
        || (selected?.model_boxes || [])[0];
      if (source && Number(source.width) > 0 && Number(source.height) > 0) {
        const className = WASTE_CLASSES.includes(source.class_name) ? source.class_name : WASTE_CLASSES[0];
        setBoxes([{
          class_name: className,
          x: Number(source.x),
          y: Number(source.y),
          width: Number(source.width),
          height: Number(source.height),
        }]);
        setDrawClass(className);
      } else {
        setBoxes([]);
      }
    }
    setZoom(1);
  }, [selectedId, selected?.status]);

  const patchReport = (id, next) => {
    setReports((current) => current.map((row) => (row.id === id ? { ...row, ...next } : row)));
  };

  const pointerPos = (event) => {
    const img = imageRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  const onPointerDown = (event) => {
    if (!editable) return;
    const pos = pointerPos(event);
    if (!pos) return;
    const handle = event.target.closest?.('[data-resize]');
    if (handle) {
      const index = Number(handle.dataset.resize);
      dragRef.current = { mode: 'resize', index, pos, box: { ...boxes[index] } };
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* released */ }
      return;
    }
    const hit = event.target.closest?.('[data-box]');
    if (hit) {
      const index = Number(hit.dataset.box);
      dragRef.current = { mode: 'move', index, pos, box: { ...boxes[index] } };
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* released */ }
      return;
    }
    dragRef.current = { mode: 'draw', pos };
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* released */ }
  };

  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.mode === 'draw') return;
    const pos = pointerPos(event);
    if (!pos) return;
    if (drag.mode === 'move') {
      const x = Math.min(1 - drag.box.width, Math.max(0, drag.box.x + (pos.x - drag.pos.x)));
      const y = Math.min(1 - drag.box.height, Math.max(0, drag.box.y + (pos.y - drag.pos.y)));
      setBoxes((current) => current.map((box, index) => (index === drag.index ? { ...box, x, y } : box)));
      return;
    }
    const width = Math.min(1 - drag.box.x, Math.max(0.01, drag.box.width + (pos.x - drag.pos.x)));
    const height = Math.min(1 - drag.box.y, Math.max(0.01, drag.box.height + (pos.y - drag.pos.y)));
    setBoxes((current) => current.map((box, index) => (index === drag.index ? { ...box, width, height } : box)));
  };

  const onPointerUp = (event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !editable || drag.mode !== 'draw') return;
    const pos = pointerPos(event);
    if (!pos) return;
    const x = Math.min(drag.pos.x, pos.x);
    const y = Math.min(drag.pos.y, pos.y);
    const width = Math.abs(pos.x - drag.pos.x);
    const height = Math.abs(pos.y - drag.pos.y);
    if (width < 0.01 || height < 0.01) return;
    setBoxes((current) => [...current, { class_name: drawClass, x, y, width, height }]);
  };

  const saveBoxes = async () => {
    if (!selected || busy) return;
    const savedBoxes = boxes.map((box) => ({
      class_name: box.class_name,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    }));
    setBusyAction('save');
    const outcome = await confirmThenRun({
      title: 'Save this correction?',
      message: 'The waste class and bounding box on this review will be updated. The original AI prediction stays visible for comparison.',
      confirmLabel: 'Save Correction',
      busyTitle: 'Saving correction',
      busyMessage: 'Updating the class and box on this review.',
      busyLabel: 'Saving…',
      successTitle: 'Correction saved',
      successMessage: 'The admin correction on this review was saved.',
      errorTitle: 'Correction not saved',
      work: () => saveMissedAnnotations(selected.id, savedBoxes),
    });
    if (outcome.ok) {
      patchReport(selected.id, outcome.result && typeof outcome.result === 'object'
        ? outcome.result
        : { annotations: savedBoxes });
    } else if (!outcome.cancelled) {
      load({ silent: true });
    }
    setBusyAction(null);
  };

  const removeReport = async (id) => {
    if (busy) return { ok: false, cancelled: true };
    setBusyAction('reject');
    const outcome = await confirmThenRun({
      title: 'Reject this review?',
      message: 'This review will be removed now. It will not be included in the training dataset.',
      confirmLabel: 'Reject Review',
      variant: 'danger',
      busyTitle: 'Rejecting review',
      busyMessage: 'Removing this review from the queue.',
      busyLabel: 'Rejecting…',
      successTitle: 'Review rejected',
      successMessage: 'The review was rejected and will not be included in the dataset.',
      errorTitle: 'Review not rejected',
      work: () => deleteMissedDetection(id),
    });
    if (outcome.ok) {
      setReports((current) => current.filter((row) => row.id !== id));
      setCounts((current) => ({
        ...current,
        pending: Math.max(0, Number(current.pending || 0) - 1),
        rejected: Number(current.rejected || 0) + 1,
      }));
      if (selectedId === id) setSelectedId(null);
    } else if (!outcome.cancelled) {
      load({ silent: true });
    }
    setBusyAction(null);
    return outcome;
  };

  const review = async (decision, includeInExport) => {
    if (!selected || busy) return;
    if (decision === 'rejected') {
      await removeReport(selected.id);
      return;
    }
    const prompt = decision === 'verified'
      ? {
          title: 'Verify this annotation?',
          message: 'The class and box will be marked verified. Approve the review before it can enter training.',
          confirmLabel: 'Verify',
          successTitle: 'Review verified',
          successMessage: 'The annotation is verified. Approve it before training.',
          action: 'verify',
        }
      : includeInExport
        ? {
            title: decision === 'approved' && selected.status === 'approved'
              ? 'Include this review in training?'
              : 'Approve this review for training?',
            message: decision === 'approved' && selected.status === 'approved'
              ? 'This approved review will be included in the next Roboflow job and ZIP export. Reviews already exported stay in the list.'
              : 'The review will be marked Approved and included in the next training set. Live best.onnx is not replaced.',
            confirmLabel: selected.status === 'approved' ? 'Include in Training' : 'Approve Review',
            successTitle: selected.status === 'approved' ? 'Included in training' : 'Review approved',
            successMessage: 'The server confirmed this review is approved and included in training.',
            action: selected.status === 'approved' ? 'include' : 'approve',
          }
        : {
            title: selected.status === 'approved' ? 'Keep this review out of training?' : 'Approve without training?',
            message: selected.status === 'approved'
              ? 'The review stays approved. It will not be added to the next training dataset.'
              : 'This annotation stays approved, but it will not be added to the training dataset until you include it.',
            confirmLabel: selected.status === 'approved' ? 'Keep out of training' : 'Approve Review',
            successTitle: 'Approved',
            successMessage: 'The server confirmed this review is approved. It is not in the training pool.',
            action: selected.status === 'approved' ? 'exclude' : 'approve',
          };
    const nextStatus = decision === 'verified' ? 'verified' : 'approved';
    const nextExport = decision === 'approved' ? Boolean(includeInExport) : selected.include_in_export;
    setBusyAction(prompt.action);
    const outcome = await confirmThenRun({
      ...prompt,
      busyTitle: prompt.title.replace('?', ''),
      busyMessage: 'Waiting for the server to confirm this review action.',
      busyLabel: 'Saving…',
      errorTitle: 'Review not updated',
      work: () => reviewMissedDetection(selected.id, decision, includeInExport),
    });
    if (outcome.ok) {
      const serverRow = outcome.result && typeof outcome.result === 'object' ? outcome.result : null;
      patchReport(selected.id, serverRow || { status: nextStatus, include_in_export: nextExport });
      setCounts((current) => {
        const from = selected.status;
        const next = { ...current };
        if (from && from !== nextStatus) {
          next[from] = Math.max(0, Number(next[from] || 0) - 1);
          next[nextStatus] = Number(next[nextStatus] || 0) + 1;
        }
        const eligibleDelta = (serverRow?.status || nextStatus) === 'approved' && (serverRow?.include_in_export ?? nextExport)
          ? (selected.include_in_export && selected.status === 'approved' ? 0 : 1)
          : (selected.include_in_export && selected.status === 'approved' ? -1 : 0);
        next.training_eligible = Math.max(0, Number(next.training_eligible || 0) + eligibleDelta);
        return next;
      });
    } else if (!outcome.cancelled) {
      load({ silent: true });
    }
    setBusyAction(null);
  };

  const downloadExport = async () => {
    if (busy) return;
    setBusyAction('export');
    setError('');
    const outcome = await confirmThenRun({
      title: 'Export approved dataset?',
      message: 'Only reviews included in training will be downloaded. Those records will be marked Exported and stay visible in this list.',
      confirmLabel: 'Download',
      busyTitle: 'Exporting dataset',
      busyMessage: 'Preparing the approved YOLO ZIP download.',
      busyLabel: 'Exporting…',
      successTitle: 'Dataset downloaded',
      successMessage: 'The approved dataset ZIP is downloading. Those records are now marked Exported.',
      errorTitle: 'Dataset not exported',
      work: async () => {
        try {
          const blob = await exportApprovedDataset();
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = 'approved-waste-dataset.zip';
          link.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          let message = 'Could not export the dataset.';
          const data = err?.response?.data;
          if (data instanceof Blob) {
            try {
              const parsed = JSON.parse(await data.text());
              message = parsed.message || message;
              if (Array.isArray(parsed.issues) && parsed.issues.length) message = `${message} ${parsed.issues.join(' ')}`;
            } catch { /* keep default */ }
          } else if (data?.message) {
            message = data.message;
          }
          throw new Error(message);
        }
      },
    });
    if (outcome.ok) {
      await load({ silent: true });
    } else if (!outcome.cancelled) {
      setError(actionErrorMessage(outcome.error, 'Could not export the dataset.'));
    }
    setBusyAction(null);
  };

  const runTrainingAction = async ({ title, message, confirmLabel, action, success, key = 'train' }) => {
    if (busy && busyAction !== 'train') return;
    setBusyAction(key);
    const outcome = await confirmThenRun({
      title,
      message,
      confirmLabel,
      busyTitle: title,
      busyMessage: 'Sending this training request. Keep this window open.',
      busyLabel: 'Working…',
      successTitle: 'Done',
      successMessage: success,
      errorTitle: 'Training request failed',
      work: action,
    });
    if (outcome.ok) {
      await Promise.all([load({ silent: true }), loadTraining()]);
    }
    setBusyAction(null);
  };

  const startRoboflowTraining = async () => {
    if (!isAdmin || busy) return;
    setBusyAction('train');
    let confirmMessage = '';
    let canStart = false;
    try {
      let payload = training;
      if (Number(training?.dataset?.eligible_reviews || 0) > 0) {
        payload = (await loadTraining({ validate: true })) || training;
      }
      const ds = payload?.dataset || {};
      const issues = Array.isArray(ds.issues) ? ds.issues : [];
      const used = Number(ds.already_exported_or_queued || 0);
      const held = Number(ds.held_out || 0);
      const lines = [
        `Reviews to include: ${Number(ds.eligible_reviews || 0).toLocaleString('en-US')}.`,
        `Images: ${Number(ds.images || 0).toLocaleString('en-US')}.`,
        `Annotations: ${Number(ds.annotations || 0).toLocaleString('en-US')}.`,
        issues.length ? `Dataset validation: ${issues.join(' ')}` : 'Dataset validation: ready.',
      ];
      if (used) {
        lines.push(`${used} review(s) are already exported or assigned to a training job and will not be included.`);
      }
      if (held) {
        lines.push(`${held} approved review(s) are held out of training.`);
      }
      lines.push('The live best.onnx file will not be replaced until you approve deployment.');
      confirmMessage = lines.join(' ');
      if (ds.valid === false || Number(ds.eligible_reviews || 0) === 0) {
        await acknowledgeAction({
          title: 'Training cannot start',
          message: confirmMessage,
          variant: 'danger',
        });
        return;
      }
      canStart = true;
    } catch (err) {
      await acknowledgeAction({
        title: 'Training cannot start',
        message: actionErrorMessage(err, 'The dataset could not be validated.'),
        variant: 'danger',
      });
      return;
    } finally {
      setBusyAction(null);
    }
    if (!canStart) return;
    await runTrainingAction({
      title: 'Train on Roboflow?',
      message: confirmMessage,
      confirmLabel: 'Start training',
      success: 'Training job started. Progress below follows the real job status.',
      action: startTrainingJob,
    });
  };

  const latestJob = training?.latest || null;
  const jobActive = ACTIVE_JOB.includes(latestJob?.status);
  const dataset = training?.dataset || {};
  const perPage = Math.max(1, Number(meta.per_page) || 10);
  const totalRows = Number(meta.total) || 0;
  const lastPage = Math.max(1, Number(meta.last_page) || 1, Math.ceil(totalRows / perPage) || 1);
  const currentPage = Math.min(Math.max(1, Number(meta.page) || page), lastPage);
  const rangeStart = totalRows === 0 ? 0 : ((currentPage - 1) * perPage) + 1;
  const rangeEnd = Math.min(totalRows, currentPage * perPage);
  const reviewerClass = boxes[0]?.class_name || selected?.annotations?.[0]?.class_name || 'No box yet';
  const originalBox = (selected?.model_boxes || [])[0] || null;
  const showAiOverlay = boxes.length === 0;

  const setFilter = (patch) => {
    setPage(1);
    setFilters((current) => ({ ...current, ...patch }));
  };

  return (
    <div className="missed-review">
      <header className="module-head">
        <div>
          <h2 className="module-title">Detection Reviews</h2>
          <p className="module-sub">
            Admins review and correct AI detections before they enter the training dataset.
            Compare the original prediction with your correction, then approve, reject, or include the frame in training.
            Rejected reviews stay out of the dataset. Live cameras keep using the current best.onnx until you approve a later deployment.
          </p>
        </div>
        <div className="module-actions">
          <button
            className="deck-btn"
            type="button"
            disabled={!isAdmin || busy || jobActive}
            aria-busy={busyAction === 'train'}
            onClick={startRoboflowTraining}
          >
            {busyAction === 'train' ? 'Checking dataset…' : 'Train on Roboflow'}
          </button>
          <button
            className="deck-btn primary"
            type="button"
            onClick={downloadExport}
            disabled={!isAdmin || busy}
            aria-busy={busyAction === 'export'}
          >
            {busyAction === 'export' ? 'Exporting…' : 'Export Approved Dataset'}
          </button>
        </div>
      </header>

      <section className="train-panel">
        <div className="train-panel-head">
          <h3>Roboflow training</h3>
          <p>
            {training?.configured
              ? `Project ${training.project || '—'} · ${training.model_type || 'yolov11'}`
              : 'Set ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, and ROBOFLOW_PROJECT in the API environment. The workflow ID is not a dataset project.'}
          </p>
        </div>
        <div className="train-metrics">
          <div className="train-metric">
            <span>Eligible approved reviews</span>
            <b>{dataset.eligible_reviews == null ? '—' : Number(dataset.eligible_reviews).toLocaleString('en-US')}</b>
          </div>
          <div className="train-metric">
            <span>Images</span>
            <b>{dataset.images == null ? '—' : Number(dataset.images).toLocaleString('en-US')}</b>
          </div>
          <div className="train-metric">
            <span>Annotations</span>
            <b>{dataset.annotations == null ? '—' : Number(dataset.annotations).toLocaleString('en-US')}</b>
          </div>
          <div className="train-metric">
            <span>Dataset validation</span>
            <b>
              {dataset.valid === true ? 'Ready' : dataset.valid === false ? 'Needs fixes' : 'Checked at start'}
            </b>
          </div>
          <div className="train-metric">
            <span>Roboflow version</span>
            <b>{latestJob?.dataset_version || '—'}</b>
          </div>
          <div className="train-metric">
            <span>Training status</span>
            <b>{latestJob?.status_label || 'No job yet'}</b>
          </div>
        </div>
        {Number(dataset.already_exported_or_queued || 0) > 0 ? (
          <p className="train-empty">
            {dataset.already_exported_or_queued} review(s) are already exported or assigned to a job.
            They remain in this list and are not silently removed from the training history.
          </p>
        ) : null}
        {Number(dataset.held_out || 0) > 0 ? (
          <p className="train-empty">
            {dataset.held_out} approved review(s) are held out of training until you include them.
          </p>
        ) : null}
        <div className="train-steps" aria-label="Training progress">
          {TRAIN_STEPS.map((step) => {
            const state = trainStepState(latestJob?.status, step.id);
            return (
              <div key={step.id} className={`train-step is-${state}`}>
                {step.label}
              </div>
            );
          })}
        </div>
        {latestJob ? (
          <div className="train-job">
            <div className="train-job-row">
              <span className={`train-status is-${latestJob.status}`}>{latestJob.status_label}</span>
              <span>Version {latestJob.dataset_version || '—'}</span>
              <span>{latestJob.uploaded_count}/{latestJob.item_count} images</span>
            </div>
            <div className="train-job-row muted">
              <span>Started {formatWhen(latestJob.started_at)}</span>
              <span>Completed {formatWhen(latestJob.completed_at)}</span>
              {latestJob.hosted_model_id ? <span>{latestJob.hosted_model_id}</span> : null}
            </div>
            {latestJob.error_message ? <p className="train-error">{latestJob.error_message}</p> : null}
            {latestJob.status === 'awaiting_evaluation' || latestJob.status === 'completed' ? (
              <label className="train-notes">
                Evaluation notes
                <textarea value={evalNotes} onChange={(event) => setEvalNotes(event.target.value)} rows={2} />
              </label>
            ) : null}
            <div className="train-actions">
              {latestJob.status === 'failed' ? (
                <button className="deck-btn" type="button" disabled={busy} onClick={() => runTrainingAction({
                  title: 'Retry training',
                  message: 'Retry upload, version creation, and training for this job.',
                  confirmLabel: 'Retry',
                  success: 'Training retry started.',
                  action: () => retryTrainingJob(latestJob.id),
                  key: 'retry',
                })}>Retry</button>
              ) : null}
              {latestJob.status === 'awaiting_evaluation' || latestJob.status === 'completed' ? (
                <>
                  <button className="deck-btn" type="button" disabled={busy} onClick={() => runTrainingAction({
                    title: 'Save evaluation',
                    message: 'Keep the previous production model until you approve deployment.',
                    confirmLabel: 'Save notes',
                    success: 'Evaluation saved.',
                    action: () => evaluateTrainingJob(latestJob.id, evalNotes),
                    key: 'eval',
                  })}>Save evaluation</button>
                  <button className="deck-btn" type="button" disabled={busy} onClick={() => runTrainingAction({
                    title: 'Approve for deployment',
                    message: 'This records approval only. Live cameras still use the current best.onnx until you deploy.',
                    confirmLabel: 'Approve',
                    success: 'Approved for deployment.',
                    action: () => approveTrainingDeployment(latestJob.id),
                    key: 'deploy-approve',
                  })}>Approve for deployment</button>
                  <button className="deck-btn" type="button" disabled={busy} onClick={() => runTrainingAction({
                    title: 'Reject model',
                    message: 'Keep the current production model. This trained version will not be deployed.',
                    confirmLabel: 'Reject',
                    success: 'Trained model rejected.',
                    action: () => rejectTrainingJob(latestJob.id),
                    key: 'deploy-reject',
                  })}>Reject</button>
                </>
              ) : null}
              {latestJob.status === 'approved_for_deployment' ? (
                <button className="deck-btn primary" type="button" disabled={busy} onClick={() => runTrainingAction({
                  title: 'Record deployment',
                  message: 'Roboflow does not push ONNX weights to this server. This records the hosted model and backs up the current local best.onnx. Replace best.onnx yourself only after you export a compatible YOLOv11 ONNX.',
                  confirmLabel: 'Record deployment',
                  success: 'Deployment recorded. Live cameras still use the local ONNX until you replace it.',
                  action: () => deployTrainingJob(latestJob.id),
                  key: 'deploy',
                })}>Record deployment</button>
              ) : null}
              {latestJob.status === 'deployed' && latestJob.backup_model_path ? (
                <button className="deck-btn" type="button" disabled={busy} onClick={() => runTrainingAction({
                  title: 'Roll back ONNX',
                  message: 'Restore the previous local best.onnx backup.',
                  confirmLabel: 'Roll back',
                  success: 'Previous local model restored.',
                  action: () => rollbackTrainingJob(latestJob.id),
                  key: 'rollback',
                })}>Roll back</button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="train-empty">No training jobs yet. Approve reviews and include them in training, then start a Roboflow job.</p>
        )}
      </section>

      <div className="stat-row missed-stats">
        <StatCard
          label="Pending Reviews"
          value={counts.pending}
          hint="Waiting for admin correction"
          active={filters.status === 'pending'}
          onClick={() => setFilter({ status: filters.status === 'pending' ? '' : 'pending' })}
        />
        <StatCard
          label="Approved Reviews"
          value={counts.approved}
          hint="Confirmed by an administrator"
          active={filters.status === 'approved'}
          onClick={() => setFilter({ status: filters.status === 'approved' ? '' : 'approved' })}
        />
        <StatCard
          label="Rejected Reviews"
          value={counts.rejected}
          hint="Removed from the training pool"
          active={filters.status === 'rejected'}
          onClick={() => setFilter({ status: filters.status === 'rejected' ? '' : 'rejected' })}
        />
        <StatCard
          label="Approved for Training"
          value={counts.training_eligible}
          hint="Approved and included in the next job"
          active={filters.status === 'approved'}
          onClick={() => setFilter({ status: 'approved' })}
        />
      </div>

      <div className="filter-bar">
        <div className="filter-field filter-search">
          <label htmlFor="missed-q">Search</label>
          <input
            id="missed-q"
            value={searchInput}
            placeholder="Camera, class, description…"
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <FilterSelect
          id="missed-status"
          label="Status"
          value={filters.status}
          options={[
            { value: '', label: 'All statuses' },
            { value: 'pending', label: 'Pending Review' },
            { value: 'verified', label: 'Verified' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'exported', label: 'Exported' },
          ]}
          onChange={(value) => setFilter({ status: value })}
        />
        <FilterSelect
          id="missed-camera"
          label="Camera"
          value={filters.camera_id}
          options={[
            { value: '', label: 'All cameras' },
            ...realCameras.map((cam) => ({ value: cam.id, label: cam.name ? `${cam.id} · ${cam.name}` : cam.id })),
          ]}
          onChange={(value) => setFilter({ camera_id: value })}
        />
        <FilterSelect
          id="missed-class"
          label="Waste class"
          value={filters.class_name}
          options={[
            { value: '', label: 'All classes' },
            ...WASTE_CLASSES.map((name) => ({ value: name, label: name })),
          ]}
          onChange={(value) => setFilter({ class_name: value })}
        />
        <FilterSelect
          id="missed-conf"
          label="Confidence"
          value={filters.confidence}
          options={[
            { value: '', label: 'All scores' },
            { value: 'lt60', label: 'Below 60%' },
            { value: '60-80', label: '60% – 79%' },
            { value: 'gte80', label: '80% and above' },
          ]}
          onChange={(value) => setFilter({ confidence: value })}
        />
        <div className="filter-field">
          <label htmlFor="missed-from">From</label>
          <input id="missed-from" type="date" value={filters.from} onChange={(event) => setFilter({ from: event.target.value })} />
        </div>
        <div className="filter-field">
          <label htmlFor="missed-to">To</label>
          <input id="missed-to" type="date" value={filters.to} onChange={(event) => setFilter({ to: event.target.value })} />
        </div>
      </div>

      <section className="panel det-table-panel">
        <div className="panel-head">
          <span className="panel-title">
            Review queue · <b>{loading && reports.length === 0 ? '…' : meta.total}</b>
          </span>
        </div>
        <div className="det-table-wrap">
          <table className="det-table">
            <thead>
              <tr>
                <th>Frame</th>
                <th>Predicted class</th>
                <th>Confidence</th>
                <th>Camera / location</th>
                <th>Detected</th>
                <th>Status</th>
                <th>Training</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && reports.length === 0 ? <ReviewSkeletonRows /> : null}
              {!loading && error ? (
                <tr>
                  <td className="det-table-empty" colSpan={8}>
                    <div className="review-error">
                      <span>{error || 'The review queue could not be loaded.'}</span>
                      <button className="deck-btn" type="button" onClick={() => load()}>Retry</button>
                    </div>
                  </td>
                </tr>
              ) : null}
              {!loading && !error && reports.length === 0 ? (
                <tr>
                  <td className="det-table-empty" colSpan={8}>
                    No detection reviews match these filters. Adjust search, status, class, or date, or wait for a new AI proposal.
                  </td>
                </tr>
              ) : null}
              {!error ? reports.map((row) => {
                const elig = trainingEligibility(row);
                return (
                  <tr key={row.id} className={row.id === selectedId ? 'is-selected' : ''}>
                    <td>
                      <button type="button" className="det-snap-btn" onClick={() => setSelectedId(row.id)} aria-label={`Open review ${row.id}`}>
                        {row.image_url ? <img src={row.image_url} alt="" /> : null}
                      </button>
                    </td>
                    <td>
                      <span className="waste-type-stack">
                        <span className="waste-cat">{row.annotations?.[0]?.class_name || row.prediction || 'None'}</span>
                        <span className="waste-sub">
                          {row.annotations?.[0]?.class_name
                            ? (row.prediction && row.prediction !== row.annotations[0].class_name
                              ? `Replaced ${row.prediction}`
                              : 'Admin class')
                            : 'AI prediction'}
                        </span>
                      </span>
                    </td>
                    <td>{formatConfidence(row.prediction_confidence)}</td>
                    <td>
                      <span className="waste-type-stack">
                        <span className="waste-cat">{row.camera_name || row.camera_id || '—'}</span>
                        <span className="waste-sub">{[row.camera_id, row.location].filter(Boolean).join(' · ')}</span>
                      </span>
                    </td>
                    <td>{formatWhen(row.created_at)}</td>
                    <td>
                      <span className={`review-pill is-${row.status}`}>{statusLabel(row.status)}</span>
                    </td>
                    <td>
                      <span className={`review-elig is-${elig.key}`}>
                        <strong>{elig.label}</strong>
                        <span className="waste-sub">{elig.reason}</span>
                      </span>
                    </td>
                    <td>
                      <button type="button" className="mini-link" onClick={() => setSelectedId(row.id)}>
                        Review
                      </button>
                    </td>
                  </tr>
                );
              }) : null}
            </tbody>
          </table>
        </div>
        <div className="missed-pager">
          <span className="waste-sub">{rangeStart}–{rangeEnd} of {meta.total}</span>
          <div className="module-actions">
            <button className="deck-btn" type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
            <button className="deck-btn" type="button" disabled={page >= lastPage} onClick={() => setPage((current) => Math.min(lastPage, current + 1))}>Next</button>
          </div>
        </div>
      </section>

      <Modal open={Boolean(selected)} onClose={() => setSelectedId(null)} labelledBy="missed-review-title">
        {selected ? (
        <div className="missed-modal">
          <div className="modal-head">
            <h3 id="missed-review-title">Review · <span>{selected.camera_name || selected.camera_id}</span></h3>
            <button className="modal-close" type="button" onClick={() => setSelectedId(null)} aria-label="Close">×</button>
          </div>
          <div className="modal-body missed-modal-body">
        <section className="missed-detail">
          <div>
            <div className="panel-head">
              <span className="panel-title">
                Frame · <b>{selected.camera_name || selected.camera_id}</b>
              </span>
              <div className="module-actions">
                <button className="deck-btn" type="button" onClick={() => setZoom(1)}>Fit</button>
                <button className="deck-btn" type="button" onClick={() => setZoom(1.5)}>150%</button>
                <button className="deck-btn" type="button" onClick={() => setZoom(2)}>200%</button>
              </div>
            </div>
            <div className="review-legend">
              {showAiOverlay ? <span><i className="is-ai" /> Original AI box</span> : null}
              {boxes.length ? <span><i className="is-admin" /> Admin correction</span> : null}
            </div>
            <div className="missed-stage-scroll">
              <div
                className="missed-stage"
                style={{ width: `${zoom * 100}%` }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                <img ref={imageRef} src={selected.image_url} alt="" draggable={false} />
                {showAiOverlay ? (selected.model_boxes || []).map((box, index) => (
                  <span
                    key={`model-${index}`}
                    className="missed-model-box"
                    style={{
                      left: `${box.x * 100}%`,
                      top: `${box.y * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
                    }}
                  >
                    <em>{box.source === 'proposal' ? 'Unfamiliar' : 'AI'} · {box.class_name || 'unlabeled'}</em>
                  </span>
                )) : null}
                {boxes.map((box, index) => (
                  <span
                    key={`${box.id || 'new'}-${index}`}
                    className="missed-box"
                    data-box={index}
                    style={{
                      left: `${box.x * 100}%`,
                      top: `${box.y * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
                    }}
                  >
                    <em>{box.class_name}</em>
                    {editable ? <i data-resize={index} className="missed-handle" /> : null}
                  </span>
                ))}
              </div>
            </div>
            <p className="module-sub missed-hint">
              {boxes.length
                ? 'The solid box is the admin correction. It replaces the original AI class and box on this frame.'
                : (selected.model_boxes || []).some((box) => box.source === 'proposal')
                  ? 'The dashed box is an unfamiliar proposal. Draw a dataset class if it belongs, or reject it.'
                  : (selected.model_boxes || []).length
                    ? 'Change the class and box, then save. The original AI prediction will leave the frame.'
                    : 'The model did not leave a box on this frame. Draw the missed object, then save the correction.'}
            </p>
          </div>
          <div className="missed-side">
            <span className={`review-pill is-${selected.status}`}>{statusLabel(selected.status)}</span>
            <div className="review-orig">
              <h4>Original detection</h4>
              <p className="waste-cat">{selected.prediction || 'None'}</p>
              <p className="waste-sub">Confidence · {formatConfidence(selected.prediction_confidence)}</p>
              <p className="waste-sub">
                {originalBox
                  ? `AI box · ${Math.round(originalBox.width * 100)}% × ${Math.round(originalBox.height * 100)}%`
                  : 'No original bounding box'}
              </p>
              <p className="waste-sub">{formatWhen(selected.created_at)} · {selected.camera_id || '—'}{selected.location ? ` · ${selected.location}` : ''}</p>
            </div>
            <div className="review-corr">
              <h4>Admin correction</h4>
              <p className="waste-cat">{reviewerClass}</p>
              <p className="waste-sub">{selectedElig.label}</p>
              <p className="module-sub">{selectedElig.reason}</p>
            </div>
            <p className="module-sub">{selected.description}</p>
            <div className="filter-field">
              <label htmlFor="missed-draw-class">Class for the next box</label>
              <select
                id="missed-draw-class"
                value={drawClass}
                disabled={!editable}
                onChange={(event) => setDrawClass(event.target.value)}
              >
                {WASTE_CLASSES.map((name, index) => (
                  <option key={name} value={name}>{index} · {name}</option>
                ))}
              </select>
            </div>
            <ul className="missed-box-list">
              {boxes.map((box, index) => (
                <li key={`${box.class_name}-${index}`}>
                  <select
                    value={box.class_name}
                    disabled={!editable}
                    aria-label={`Class for box ${index + 1}`}
                    onChange={(event) => {
                      const name = event.target.value;
                      setBoxes((current) => current.map((item, itemIndex) => (
                        itemIndex === index ? { ...item, class_name: name } : item
                      )));
                    }}
                  >
                    {WASTE_CLASSES.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                  {editable ? (
                    <button type="button" className="mini-link" onClick={() => setBoxes((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                      Delete
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {editable ? (
              <button
                className="deck-btn"
                type="button"
                onClick={saveBoxes}
                disabled={busy}
                aria-busy={busyAction === 'save'}
              >
                {busyAction === 'save' ? 'Saving…' : 'Save Correction'}
              </button>
            ) : null}
            {isAdmin && selected.status === 'pending' ? (
              <div className="module-actions">
                <button className="deck-btn" type="button" onClick={() => review('verified')} disabled={busy} aria-busy={busyAction === 'verify'}>
                  {busyAction === 'verify' ? 'Verifying…' : 'Verify'}
                </button>
                <button className="deck-btn primary" type="button" onClick={() => review('approved', true)} disabled={busy} aria-busy={busyAction === 'approve'}>
                  {busyAction === 'approve' ? 'Approving…' : 'Approve Review'}
                </button>
                <button className="deck-btn" type="button" onClick={() => review('rejected')} disabled={busy} aria-busy={busyAction === 'reject'}>
                  {busyAction === 'reject' ? 'Rejecting…' : 'Reject Review'}
                </button>
              </div>
            ) : null}
            {isAdmin && selected.status === 'verified' ? (
              <div className="module-actions">
                <button className="deck-btn primary" type="button" onClick={() => review('approved', true)} disabled={busy} aria-busy={busyAction === 'approve'}>
                  {busyAction === 'approve' ? 'Approving…' : 'Approve Review'}
                </button>
                <button className="deck-btn" type="button" onClick={() => review('approved', false)} disabled={busy}>
                  Approve without training
                </button>
                <button className="deck-btn" type="button" onClick={() => review('rejected')} disabled={busy} aria-busy={busyAction === 'reject'}>
                  {busyAction === 'reject' ? 'Rejecting…' : 'Reject Review'}
                </button>
              </div>
            ) : null}
            {isAdmin && selected.status === 'approved' ? (
              <div className="module-actions">
                <button
                  className="deck-btn primary"
                  type="button"
                  onClick={() => review('approved', true)}
                  disabled={busy || selected.include_in_export}
                  aria-busy={busyAction === 'include'}
                >
                  {busyAction === 'include' ? 'Updating…' : 'Include in Training'}
                </button>
                <button
                  className="deck-btn"
                  type="button"
                  onClick={() => review('approved', false)}
                  disabled={busy || !selected.include_in_export}
                  aria-busy={busyAction === 'exclude'}
                >
                  Keep out of training
                </button>
              </div>
            ) : null}
            {selected.status === 'exported' || selected.training_job_id ? (
              <p className="waste-sub">This review was already used in a training job or ZIP export. It remains listed here.</p>
            ) : null}
          </div>
        </section>
          </div>
        </div>
        ) : null}
      </Modal>
    </div>
  );
}
