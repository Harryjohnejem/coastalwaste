import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { REVIEW_POLL_MS, WASTE_CLASSES } from '../../constants';
import { useClassesStore } from '../../stores/useClassesStore';
import usePageVisible from '../../hooks/usePageVisible';
import { useAuthStore } from '../../stores/useAuthStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import AddWasteModal from './AddWasteModal';
import client from '../../api/client';
import FilterSelect from '../common/FilterSelect';
import { readHitLimit } from '../common/HitLimitSelect';
import TablePager, { readPageSize, savePageSize } from '../common/TablePager';
import Modal from '../common/Modal';
import TableSelectAll from '../common/TableSelectAll';
import {
  deleteMissedDetections,
  exportApprovedDataset,
  listMissedDetectionIds,
  listMissedDetections,
  reviewMissedDetection,
  saveMissedAnnotations,
} from '../../api/missedDetections';
import {
  approveTrainingDeployment,
  deployTrainingJob,
  dismissTrainingJob,
  evaluateTrainingJob,
  listTrainingJobs,
  pickTrainingData,
  rejectTrainingJob,
  retryTrainingJob,
  rollbackTrainingJob,
  startRoboflowRecipe,
  startTrainingJob,
  updateTrainingSampleLimit,
} from '../../api/trainingJobs';
import { acknowledgeAction, actionErrorMessage, confirmThenRun } from '../../stores/useNoticeStore';

const SAMPLE_LIMIT_STORAGE_KEY = 'tidalwatch-approved-samples-per-class';
const SAMPLE_LIMIT_OPTIONS = [10, 20, 50, 100, 200, 500, 1000];
/** Not offered when labelling boxes in Detection Reviews. Old boxes keep their class. */
const HIDDEN_REVIEW_CLASSES = ['Cardboard', 'Paper Bag', 'Paper Drink Carton', 'Plastic Bag'];
/** Not needed for training readiness (API TrainingSamplePlan::OPTIONAL_CLASSES). */
const TRAINING_OPTIONAL_CLASSES = ['Cardboard', 'Paper Bag', 'Paper Drink Carton', 'Plastic Bag'];

function readSavedSampleLimit() {
  try {
    const value = Number(window.localStorage.getItem(SAMPLE_LIMIT_STORAGE_KEY));
    return SAMPLE_LIMIT_OPTIONS.includes(value) ? value : null;
  } catch {
    return null;
  }
}

function rememberSampleLimit(value) {
  try {
    window.localStorage.setItem(SAMPLE_LIMIT_STORAGE_KEY, String(value));
  } catch {
    // The server setting remains authoritative when browser storage is unavailable.
  }
}

function reviewParams(filters) {
  const params = {};
  if (filters.for_training) params.for_training = 1;
  else if (filters.status) params.status = filters.status;
  if (filters.camera_id) params.camera_id = filters.camera_id;
  if (filters.class_name) params.class_name = filters.class_name;
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;
  if (filters.confidence === 'lt60') params.max_confidence = 0.6;
  if (filters.confidence === '60-80') {
    params.min_confidence = 0.6;
    params.max_confidence = 0.8;
  }
  if (filters.confidence === 'gte80') params.min_confidence = 0.8;
  return params;
}

const EMPTY_COUNTS = {
  pending: null,
  verified: null,
  corrected: null,
  approved: null,
  rejected: null,
  exported: null,
  training_eligible: null,
};

const TRAIN_STEPS = [
  { id: 'upload', label: '1. Upload dataset' },
  { id: 'architecture', label: '2. YOLOv11 Large' },
  { id: 'pick', label: '3. Pick your data' },
  { id: 'epochs', label: '4. Epochs 350' },
  { id: 'training', label: 'Training' },
  { id: 'installing', label: 'Installing weights' },
  { id: 'done', label: 'Completed / Failed' },
];

const PIPELINE = ['upload', 'architecture', 'pick', 'epochs', 'training', 'installing'];
const ACTIVE_JOB = ['preparing', 'uploading', 'ready_to_pick', 'creating_version', 'ready_to_train', 'training', 'installing'];
const TERMINAL_JOB = [
  'completed',
  'failed',
  'awaiting_evaluation',
  'approved_for_deployment',
  'deployed',
  'rejected',
  'dismissed',
];
const CLEARABLE_JOB = ['failed', 'completed', 'awaiting_evaluation', 'approved_for_deployment', 'deployed', 'rejected'];

function statusLabel(status) {
  if (status === 'pending') return 'Pending Review';
  if (status === 'verified') return 'Verified';
  if (status === 'corrected') return 'Corrected';
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
  if (row.status === 'verified' || row.status === 'corrected') {
    return {
      key: 'wait',
      label: row.status === 'corrected' ? 'Corrected · needs approval' : 'Verified · needs approval',
      reason: 'A correction never enters training until an administrator explicitly approves it.',
    };
  }
  return {
    key: 'wait',
    label: 'Needs review',
    reason: 'Correct the class and box, then approve before training.',
  };
}

function formatDuration(seconds, { remaining = false } = {}) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.round(total / 60);
  if (minutes < 1) return remaining ? 'less than a minute left' : 'just started';
  if (minutes < 60) {
    const label = minutes === 1 ? '1 minute' : `${minutes} minutes`;
    return remaining ? `about ${label} left` : `${label} elapsed`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const hourLabel = hours === 1 ? '1 hour' : `${hours} hours`;
  const minLabel = mins === 0 ? '' : mins === 1 ? ' 1 minute' : ` ${mins} minutes`;
  const label = `${hourLabel}${minLabel}`;
  return remaining ? `about ${label} left` : `${label} elapsed`;
}

function trainingProgressView(job, now = Date.now()) {
  if (!job) return null;
  const status = job.status;
  const total = Number(job.item_count) || 0;
  const uploaded = Number(job.uploaded_count) || 0;
  const started = Date.parse(job.started_at || '') || now;
  const elapsedSec = Math.max(0, (now - started) / 1000);

  if ((status === 'preparing' || status === 'uploading') && uploaded === 0) {
    return {
      label: status === 'uploading' ? 'Upload starting' : 'Waiting to start upload',
      detail: status === 'uploading' ? 'The first image is on its way.' : 'The upload has not started yet.',
      percent: 0,
      indeterminate: status === 'uploading',
    };
  }
  if (status === 'preparing' || status === 'uploading') {
    const percent = total > 0 ? Math.min(100, Math.round((uploaded / total) * 100)) : 0;
    const remaining = total - uploaded;
    const detail = uploaded > 0 && remaining > 0
      ? formatDuration((elapsedSec / uploaded) * remaining, { remaining: true })
      : 'Upload finished.';
    return {
      label: `Uploading ${uploaded} of ${total || uploaded}`,
      detail,
      percent,
      indeterminate: false,
    };
  }
  if (status === 'creating_version') {
    return {
      label: 'Creating the Roboflow version',
      detail: null,
      percent: 0,
      indeterminate: true,
    };
  }
  if (status === 'installing') {
    return {
      label: 'Downloading weights and connecting them to the cameras',
      detail: null,
      percent: 0,
      indeterminate: true,
    };
  }
  if (status === 'training') {
    const metrics = job.metrics && typeof job.metrics === 'object' ? job.metrics : {};
    const epochs = Number(job.epochs) || 350;
    let fraction = null;
    const rawProgress = Number(metrics.progress);
    if (Number.isFinite(rawProgress) && rawProgress > 0) {
      fraction = rawProgress > 1 ? Math.min(1, rawProgress / 100) : Math.min(1, rawProgress);
    }
    const epoch = Number(metrics.epoch);
    if ((fraction == null || fraction <= 0) && Number.isFinite(epoch) && epoch > 0 && epochs > 0) {
      fraction = Math.min(1, epoch / epochs);
    }
    const trainStarted = Date.parse(job.manifest?.training_started_at || '') || started;
    const trainElapsed = Math.max(0, (now - trainStarted) / 1000);
    const percent = fraction == null ? 0 : Math.round(fraction * 100);
    const label = Number.isFinite(epoch) && epoch > 0
      ? `Training · epoch ${Math.round(epoch)} of ${epochs}`
      : 'Training';
    let detail = `${formatDuration(trainElapsed)}. Roboflow has not reported a finish time yet.`;
    if (fraction != null && fraction > 0 && fraction < 1) {
      detail = formatDuration((trainElapsed / fraction) * (1 - fraction), { remaining: true });
    } else if (fraction != null && fraction >= 1) {
      detail = 'Finishing.';
    }
    return { label, detail, percent, indeterminate: fraction == null };
  }
  return null;
}

function TrainProgress({ job }) {
  const view = trainingProgressView(job);
  if (!view) return null;
  return (
    <div className="train-progress" aria-live="polite">
      <div className="train-progress-label">
        <span>{view.label}</span>
        {view.detail ? <span>{view.detail}</span> : null}
      </div>
      <div
        className={`train-progress-track${view.indeterminate ? ' is-indeterminate' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.indeterminate ? undefined : view.percent}
        aria-label={view.label}
      >
        <span style={view.indeterminate ? undefined : { width: `${view.percent}%` }} />
      </div>
    </div>
  );
}

function pipelineIndex(status) {
  if (status === 'preparing' || status === 'uploading') return 0;
  if (status === 'ready_to_pick' || status === 'creating_version') return 2;
  if (status === 'ready_to_train') return 3;
  if (status === 'training') return 4;
  if (status === 'installing') return 5;
  if (TERMINAL_JOB.includes(status)) return 6;
  return -1;
}

function trainStepState(status, stepId) {
  if (!status) return 'idle';
  if (stepId === 'done') {
    if (status === 'failed') return 'failed';
    if (TERMINAL_JOB.includes(status)) return 'current';
    return 'idle';
  }
  const current = pipelineIndex(status);
  const idx = PIPELINE.indexOf(stepId);
  if (TERMINAL_JOB.includes(status) && status !== 'failed') return 'done';
  if (status === 'failed') {
    return idx <= Math.max(current, 0) ? 'done' : 'idle';
  }
  if (current === -1 || idx === -1) return 'idle';
  if (idx < current) return 'done';
  if (idx === current) return 'current';
  return 'idle';
}

function formatMap(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const value = metrics.map ?? metrics.mAP ?? metrics.map50;
  if (value == null || Number.isNaN(Number(value))) return null;
  const n = Number(value);
  if (n <= 1) return `${Math.round(n * 1000) / 10}%`;
  return String(n);
}

function classHitRows(counts, names) {
  const byName = new Map();
  (counts || []).forEach((row) => {
    const name = String(row?.name || '').trim();
    if (name) byName.set(name.toLowerCase(), Number(row.count) || 0);
  });
  return names.map((name) => ({ name, eligible: byName.get(name.toLowerCase()) || 0 }));
}

function StatCard({ label, value, hint, active, onClick }) {
  return (
    <button
      className={`stat${active ? ' is-active' : ''}`}
      type="button"
      title={hint}
      aria-label={`${label}: ${value == null ? 'unavailable' : Number(value).toLocaleString('en-US')}${hint ? `. ${hint}` : ''}`}
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
      <td colSpan={9}><div className="review-skel-bar" /></td>
    </tr>
  ));
}

export default function MissedDetectionReview({ cameras = [] }) {
  const pageVisible = usePageVisible();
  const user = useAuthStore((s) => s.user);
  const setAuth = useAuthStore((s) => s.setAuth);
  const isAdmin = String(user?.role || '').toLowerCase() === 'admin';
  const wasteCatalog = useSettingsStore((s) => s.wasteCatalog);
  const fetchWasteCatalog = useSettingsStore((s) => s.fetchWasteCatalog);
  const [addKind, setAddKind] = useState(null);
  const [reports, setReports] = useState([]);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [meta, setMeta] = useState({ page: 1, per_page: 10, total: 0, last_page: 1 });
  const [page, setPage] = useState(1);
  const [pageSize] = useState(() => readHitLimit('tidalwatch-review-hits', 50));
  const [rowsPerPage, setRowsPerPage] = useState(() => readPageSize('tidalwatch-review-page-size', 50));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    status: '',
    for_training: false,
    camera_id: '',
    class_name: '',
    from: '',
    to: '',
    confidence: '',
  });
  const [approvedHits, setApprovedHits] = useState([]);
  const [approvedClassOpen, setApprovedClassOpen] = useState(false);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectingAll, setSelectingAll] = useState(false);
  const [boxes, setBoxes] = useState([]);
  const classesVersion = useClassesStore((s) => s.version);
  const [drawClass, setDrawClass] = useState(WASTE_CLASSES[0]);
  const classOptions = useMemo(() => {
    const hidden = new Set(HIDDEN_REVIEW_CLASSES.map((name) => name.toLowerCase()));
    const names = WASTE_CLASSES.filter((name) => !hidden.has(name.toLowerCase()));
    const seen = new Set([...names, ...HIDDEN_REVIEW_CLASSES].map((name) => name.toLowerCase()));
    for (const category of wasteCatalog || []) {
      for (const row of category.classifications || []) {
        const name = String(row.name || '').trim();
        const key = name.toLowerCase();
        if (!name || seen.has(key)) continue;
        seen.add(key);
        names.push(name);
      }
    }
    return names;
    // classesVersion: re-run when new classes arrive (deployed model, catalog).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wasteCatalog, classesVersion]);
  const [zoom, setZoom] = useState(1);
  const [busyAction, setBusyAction] = useState(null);
  const [sampleLimitSaving, setSampleLimitSaving] = useState(false);
  const [training, setTraining] = useState(null);
  const [evalNotes, setEvalNotes] = useState('');
  const imageRef = useRef(null);
  const dragRef = useRef(null);
  const loadAbortRef = useRef(null);
  const loadInFlight = useRef(false);
  const trainingAbortRef = useRef(null);
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

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchWasteCatalog();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchWasteCatalog]);

  const load = useCallback(async ({ silent } = {}) => {
    if (silent && loadInFlight.current) return;
    if (!silent) setLoading(true);
    if (!silent) setError('');
    loadAbortRef.current?.abort?.();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    loadInFlight.current = true;
    try {
      const params = { page, per_page: pageSize, page_size: rowsPerPage, per_class: 1, ...reviewParams(filters) };
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
      if (loadAbortRef.current === controller) {
        loadInFlight.current = false;
        if (!silent) setLoading(false);
      }
    }
  }, [filters, page, pageSize, rowsPerPage]);

  const loadTraining = useCallback(async ({ validate = false } = {}) => {
    if (!isAdmin) return null;
    trainingAbortRef.current?.abort?.();
    const controller = new AbortController();
    trainingAbortRef.current = controller;
    try {
      const payload = await listTrainingJobs(validate ? { validate: 1 } : {}, { signal: controller.signal });
      if (controller.signal.aborted) return null;
      if (payload?.sample_limit) rememberSampleLimit(payload.sample_limit);
      setTraining(payload);
      return payload;
    } catch (err) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return null;
      return null;
    }
  }, [isAdmin]);

  const changeSampleLimit = async (value) => {
    const next = Number(value);
    if (!isAdmin || sampleLimitSaving) return;
    const previous = training?.sample_limit;
    setSampleLimitSaving(true);
    setError('');
    // Show the new requirement right away; the server reply confirms it.
    setTraining((current) => ({ ...current, sample_limit: next }));
    try {
      const payload = await updateTrainingSampleLimit(next);
      rememberSampleLimit(payload.sample_limit);
      setTraining((current) => ({
        ...current,
        sample_limit: payload.sample_limit,
        dataset: {
          ...(current?.dataset || {}),
          sample_plan: payload.sample_plan,
        },
      }));
    } catch (err) {
      setTraining((current) => ({ ...current, sample_limit: previous }));
      setError(actionErrorMessage(err, 'Could not save the approved sample requirement.'));
    } finally {
      setSampleLimitSaving(false);
    }
  };

  const loadApprovedCounts = useCallback(async (signal) => {
    if (isAdmin) return;
    const approved = await listMissedDetections({
      class_counts: 1,
      per_class: 1,
      per_page: pageSize,
      ...reviewParams({ ...filters, status: '', for_training: false }),
      status: 'approved',
    }, { signal });
    setApprovedHits(Array.isArray(approved?.classes) ? approved.classes : []);
  }, [filters, isAdmin, pageSize]);

  useEffect(() => {
    load();
    return () => {
      loadAbortRef.current?.abort?.();
    };
  }, [load]);

  useEffect(() => {
    loadTraining();
    return () => {
      trainingAbortRef.current?.abort?.();
    };
  }, [loadTraining]);

  const loadRef = useRef(load);
  loadRef.current = load;
  const loadTrainingRef = useRef(loadTraining);
  loadTrainingRef.current = loadTraining;
  const loadApprovedCountsRef = useRef(loadApprovedCounts);
  loadApprovedCountsRef.current = loadApprovedCounts;
  const approvedCountsAbortRef = useRef(null);

  useEffect(() => {
    approvedCountsAbortRef.current?.abort?.();
    const controller = new AbortController();
    approvedCountsAbortRef.current = controller;
    loadApprovedCounts(controller.signal).catch((err) => {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
    });
    return () => controller.abort();
  }, [loadApprovedCounts]);
  useEffect(() => {
    if (!pageVisible) return undefined;
    const timer = setInterval(() => {
      if (busyAction || loadInFlight.current) return;
      loadRef.current({ silent: true });
      loadTrainingRef.current();
      const countsController = new AbortController();
      approvedCountsAbortRef.current?.abort?.();
      approvedCountsAbortRef.current = countsController;
      loadApprovedCountsRef.current(countsController.signal).catch((err) => {
        if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      });
    }, REVIEW_POLL_MS);
    return () => clearInterval(timer);
  }, [pageVisible, busyAction]);

  useEffect(() => {
    if (!pageVisible || !isAdmin) return undefined;
    const status = training?.latest?.status;
    if (!ACTIVE_JOB.includes(status)) return undefined;
    const timer = setInterval(() => {
      loadTrainingRef.current();
    }, 8000);
    return () => clearInterval(timer);
  }, [pageVisible, isAdmin, training?.latest?.status]);

  const selected = reports.find((row) => row.id === selectedId) || null;
  const totalRows = Number(meta.total) || 0;
  const selectedCount = selectedIds.size;
  const allSelected = totalRows > 0 && selectedCount >= totalRows;
  const someSelected = selectedCount > 0 && !allSelected;
  const headerCheckRef = useRef(null);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [filters, pageSize]);

  useEffect(() => {
    if (filters.status === 'approved' && !filters.for_training) return;
    setApprovedClassOpen(false);
  }, [filters.status, filters.for_training]);

  useEffect(() => {
    if (headerCheckRef.current) {
      headerCheckRef.current.indeterminate = Boolean(someSelected);
    }
  }, [someSelected]);

  const toggleAll = async () => {
    if (selectingAll || busy) return;
    if (allSelected) {
      setSelectedIds(new Set());
      return;
    }
    setSelectingAll(true);
    try {
      const ids = await listMissedDetectionIds({
        ...reviewParams(filters),
        per_class: 1,
        per_page: pageSize,
      });
      setSelectedIds(new Set(ids));
    } catch (err) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setError('Could not select every review.');
    } finally {
      setSelectingAll(false);
    }
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
  const editable = Boolean(isAdmin && selected && (
    ['pending', 'verified', 'corrected'].includes(selected.status)
    || (selected.status === 'approved' && !selected.training_job_id)
  ));
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
      const knownName = (value) => {
        const raw = String(value || '').trim();
        const official = WASTE_CLASSES.find((name) => name.toLowerCase() === raw.toLowerCase());
        if (official) return official;
        const catalog = useSettingsStore.getState().wasteCatalog || [];
        for (const category of catalog) {
          for (const row of category.classifications || []) {
            const label = String(row?.name || '').trim();
            if (label && label.toLowerCase() === raw.toLowerCase()) return label;
          }
        }
        return '';
      };
      const source = (selected?.model_boxes || []).find((box) => knownName(box.class_name))
        || (selected?.model_boxes || [])[0];
      if (source && Number(source.width) > 0 && Number(source.height) > 0) {
        const className = knownName(source.class_name) || String(source.class_name || '').trim();
        if (!className) {
          setBoxes([]);
        } else {
          setBoxes([{
            class_name: className,
            x: Number(source.x),
            y: Number(source.y),
            width: Number(source.width),
            height: Number(source.height),
          }]);
          if (knownName(className)) setDrawClass(className);
        }
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
      await Promise.all([load({ silent: true }), loadTraining()]);
    } else if (!outcome.cancelled) {
      load({ silent: true });
    }
    setBusyAction(null);
  };

  const removeReport = async (id) => {
    if (busy) return { ok: false, cancelled: true };
    const currentRow = reports.find((row) => row.id === id);
    setBusyAction('reject');
    const outcome = await confirmThenRun({
      title: 'Reject this review?',
      message: 'This review stays listed as Rejected. It will not be included in the training dataset.',
      confirmLabel: 'Reject Review',
      variant: 'danger',
      busyTitle: 'Rejecting review',
      busyMessage: 'Marking this review as rejected.',
      busyLabel: 'Rejecting…',
      successTitle: 'Review rejected',
      successMessage: 'The review was rejected and will not be included in the dataset.',
      errorTitle: 'Review not rejected',
      work: () => reviewMissedDetection(id, 'rejected'),
    });
    if (outcome.ok) {
      const serverRow = outcome.result && typeof outcome.result === 'object' ? outcome.result : { status: 'rejected' };
      if (filters.status && filters.status !== 'rejected') {
        setReports((current) => current.filter((row) => row.id !== id));
      } else {
        patchReport(id, serverRow);
      }
      setCounts((current) => {
        const from = currentRow?.status || 'pending';
        const next = { ...current };
        if (from !== 'rejected') {
          next[from] = Math.max(0, Number(next[from] || 0) - 1);
        }
        next.rejected = Number(current.rejected || 0) + (from === 'rejected' ? 0 : 1);
        return next;
      });
      if (selectedId === id) setSelectedId(null);
    } else if (!outcome.cancelled) {
      load({ silent: true });
    }
    setBusyAction(null);
    return outcome;
  };

  const removeSelectedReports = async () => {
    const ids = [...selectedIds];
    if (!ids.length || busy || !isAdmin) return;
    setBusyAction('reject-bulk');
    const outcome = await confirmThenRun({
      title: `Delete ${ids.length} reviews?`,
      message: `${ids.length} selected reviews will be removed, including reviews on other pages and approved or exported reviews.`,
      confirmLabel: 'Delete selected',
      variant: 'danger',
      busyTitle: 'Deleting reviews',
      busyMessage: `Removing ${ids.length} reviews from the queue.`,
      busyLabel: 'Deleting…',
      successTitle: 'Reviews deleted',
      successMessage: (result) => {
        const deleted = result?.deleted?.length ?? 0;
        const kept = result?.kept?.length ?? 0;
        if (kept > 0) {
          return `${deleted} reviews were deleted. ${kept} reviews were kept because a training job that is still running uses them.`;
        }
        return `${deleted} reviews were deleted and will not be included in the dataset.`;
      },
      errorTitle: 'Reviews not deleted',
      work: () => deleteMissedDetections(ids),
    });
    if (outcome.ok) {
      const gone = new Set(outcome.result?.deleted || []);
      if (gone.has(selectedId)) setSelectedId(null);
      setSelectedIds(new Set());
      if (page !== 1) setPage(1);
      else load({ silent: true });
    } else if (!outcome.cancelled) {
      load({ silent: true });
    }
    setBusyAction(null);
  };

  const review = async (decision, includeInExport) => {
    if (!selected || busy) return;
    if (decision === 'rejected') {
      await removeReport(selected.id);
      return;
    }
    const prompt = decision === 'verified' || decision === 'corrected'
      ? {
          title: 'Mark this review corrected?',
          message: 'This review remains ineligible for training until an administrator explicitly approves it.',
          confirmLabel: 'Mark corrected',
          successTitle: 'Review corrected',
          successMessage: 'The review is corrected. Approve it before training.',
          action: 'corrected',
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
    const nextStatus = ['verified', 'corrected'].includes(decision) ? 'corrected' : 'approved';
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
      const plan = ds.sample_plan || {};
      const issues = Array.isArray(ds.issues) ? ds.issues : [];
      const used = Number(ds.already_exported_or_queued || 0);
      const held = Number(ds.held_out || 0);
      const uploadCount = Number(plan.selected_reviews ?? ds.images ?? 0);
      const perClass = Number(plan.required || 50);
      const missing = Array.isArray(plan.classes)
        ? plan.classes.filter((row) => Number(row.remaining) > 0)
        : [];
      const lines = [
        `Reviews eligible: ${Number(plan.eligible_reviews ?? ds.eligible_reviews ?? 0).toLocaleString('en-US')}.`,
        `Reviews in this upload: ${uploadCount.toLocaleString('en-US')} (balanced to at least ${perClass.toLocaleString('en-US')} per class).`,
        `Training readiness: ${plan.ready ? 'READY' : 'NOT READY'}. ${Number(plan.classes_ready || 0)} of ${Number(plan.classes_ready || 0) + Number(plan.classes_below_minimum || 0)} classes ready.`,
        missing.length ? `Still needed: ${missing.map((row) => `${row.name} ${row.remaining}`).join(', ')}.` : '',
        `Images: ${Number(ds.images || 0).toLocaleString('en-US')}.`,
        `Annotations: ${Number(ds.annotations || 0).toLocaleString('en-US')}.`,
        issues.length ? `Dataset validation: ${issues.join(' ')}` : 'Dataset validation: ready.',
      ];
      if (used) {
        lines.push(`${used} review(s) have training history and remain available in cumulative versions.`);
      }
      if (held) {
        lines.push(`${held} approved review(s) are held out of training.`);
      }
      lines.push('This uploads images and labels only. Reaching a class limit does not start training. Architecture stays YOLOv11 Large. You pick the data next, then train for 350 epochs.');
      confirmMessage = lines.join(' ');
      const selectedForUpload = Number(plan.selected_reviews ?? 0);
      if (!plan.ready || ds.valid === false || selectedForUpload === 0) {
        await acknowledgeAction({
          title: 'Upload cannot start',
          message: confirmMessage,
          variant: 'danger',
        });
        return;
      }
      canStart = true;
    } catch (err) {
      await acknowledgeAction({
        title: 'Upload cannot start',
        message: actionErrorMessage(err, 'The dataset could not be validated.'),
        variant: 'danger',
      });
      return;
    } finally {
      setBusyAction(null);
    }
    if (!canStart) return;
    await runTrainingAction({
      title: 'Upload dataset to Roboflow?',
      message: confirmMessage,
      confirmLabel: 'Upload dataset',
      success: 'Upload started. After it finishes, pick your data, then train YOLOv11 Large for 350 epochs.',
      action: startTrainingJob,
    });
  };

  const latestJob = training?.latest || null;
  const savedEvalNotes = latestJob?.evaluation_notes ?? '';
  const latestJobId = latestJob?.id ?? null;
  const syncedEvalRef = useRef({ id: null, notes: '' });
  // Show the saved notes after a refresh, and pick up new saves, without
  // overwriting text the admin is still typing.
  useEffect(() => {
    const synced = syncedEvalRef.current;
    const sameJob = synced.id === latestJobId;
    setEvalNotes((current) => (!sameJob || current === synced.notes ? savedEvalNotes : current));
    syncedEvalRef.current = { id: latestJobId, notes: savedEvalNotes };
  }, [latestJobId, savedEvalNotes]);
  const jobActive = ACTIVE_JOB.includes(latestJob?.status);
  const dataset = training?.dataset || {};
  const sampleLimit = Number(training?.sample_limit || dataset.sample_plan?.required || readSavedSampleLimit() || 50);
  const perPage = Math.max(1, Number(meta.per_page) || 10);
  const lastPage = Math.max(1, Number(meta.last_page) || 1, Math.ceil(totalRows / perPage) || 1);
  const currentPage = Math.min(Math.max(1, Number(meta.page) || page), lastPage);
  const reviewerClass = boxes[0]?.class_name || selected?.annotations?.[0]?.class_name || 'No box yet';
  const originalBox = (selected?.model_boxes || [])[0] || null;
  const showAiOverlay = (selected?.model_boxes || []).length > 0;

  const setFilter = (patch) => {
    setPage(1);
    setFilters((current) => ({ ...current, ...patch }));
  };
  const clearFilters = () => {
    setShowMoreFilters(false);
    setFilter({
      status: '',
      for_training: false,
      camera_id: '',
      class_name: '',
      from: '',
      to: '',
      confidence: '',
    });
  };
  const filtersActive = Boolean(
    filters.status || filters.for_training || filters.camera_id || filters.class_name
    || filters.from || filters.to || filters.confidence,
  );
  const cameraLabel = realCameras.find((cam) => cam.id === filters.camera_id);
  const filterBits = [];
  if (filters.for_training) filterBits.push('ready for the next training');
  else if (filters.status === 'pending') filterBits.push('waiting for a decision');
  else if (filters.status === 'corrected') filterBits.push('corrected and awaiting approval');
  else if (filters.status === 'approved') filterBits.push('approved');
  else if (filters.status === 'rejected') filterBits.push('rejected');
  else if (filters.status === 'verified') filterBits.push('verified');
  else if (filters.status === 'exported') filterBits.push('already used in training');
  if (filters.camera_id) filterBits.push(cameraLabel?.name ? `${filters.camera_id} ${cameraLabel.name}` : filters.camera_id);
  if (filters.class_name) filterBits.push(filters.class_name);
  if (filters.confidence === 'lt60') filterBits.push('under 60% confidence');
  if (filters.confidence === '60-80') filterBits.push('60% to 79% confidence');
  if (filters.confidence === 'gte80') filterBits.push('80% or higher confidence');
  if (filters.from || filters.to) filterBits.push('in the chosen dates');
  const approvedByClass = dataset.sample_plan?.classes || [];
  const fallbackApprovedByClass = classHitRows(approvedHits, WASTE_CLASSES);
  const approvedRows = WASTE_CLASSES
    .filter((name) => !TRAINING_OPTIONAL_CLASSES.includes(name))
    .map((name) => {
      const row = (isAdmin ? approvedByClass : fallbackApprovedByClass).find((item) => item.name === name);
      const eligible = Number(row?.eligible) || 0;
      const remaining = Math.max(0, sampleLimit - eligible);
      // A new class nobody has labelled yet does not block training.
      const optional = Boolean(row?.optional) && eligible === 0;
      return { name, eligible, remaining, optional, status: optional ? 'optional' : remaining ? 'waiting' : 'ready' };
    });
  // Readiness follows the chosen requirement at once, without waiting for the next poll.
  const planClasses = (dataset.sample_plan?.classes || []).filter(
    (row) => !row?.optional && !TRAINING_OPTIONAL_CLASSES.includes(row?.name),
  );
  const classesReady = planClasses.length
    ? planClasses.filter((row) => (Number(row?.eligible) || 0) >= sampleLimit).length
    : null;
  const planReady = planClasses.length > 0 && classesReady === planClasses.length;
  const shownCount = loading && reports.length === 0 ? null : Number(meta.total) || 0;
  const filterSummary = shownCount == null
    ? 'Looking up reviews…'
    : filterBits.length === 0
      ? `${shownCount.toLocaleString('en-US')} review${shownCount === 1 ? '' : 's'}`
      : `${shownCount.toLocaleString('en-US')} review${shownCount === 1 ? '' : 's'} · ${filterBits.join(' · ')}`;

  return (
    <div className="missed-review">
      <header className="module-head">
        <div>
          <h2 className="module-title">Detection Reviews</h2>
          <p className="module-sub">
            Admins review and correct AI detections before they enter the training dataset.
            Compare the original prediction with your correction, then approve, reject, or include the frame in training.
            Training follows Roboflow: upload the dataset, lock YOLOv11 Large, pick the uploaded data, then train for 350 epochs. Evaluate the result and approve deployment before replacing the active camera weights.
          </p>
        </div>
        <div className="module-actions">
          <button
            className="deck-btn"
            type="button"
            disabled={!isAdmin || busy || jobActive || !planReady}
            aria-busy={busyAction === 'train'}
            onClick={startRoboflowTraining}
          >
            {busyAction === 'train' ? 'Checking dataset…' : 'Upload dataset'}
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
              ? `Project ${training.project || '—'} · YOLOv11 Large · 350 epochs`
              : 'Set ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, and ROBOFLOW_PROJECT in the API environment. The workflow ID is not a dataset project.'}
          </p>
        </div>
        <div className="train-metrics">
          <div className="train-metric">
            <span>Valid approved samples</span>
            <b>{dataset.sample_plan?.total_approved_samples == null ? '—' : Number(dataset.sample_plan.total_approved_samples).toLocaleString('en-US')}</b>
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
          <div className="train-metric">
            <span>Classes ready</span>
            <b>{classesReady ?? '—'} / {planClasses.length || '—'}</b>
          </div>
          <div className="train-metric">
            <span>Below minimum</span>
            <b>{classesReady == null ? '—' : planClasses.length - classesReady}</b>
          </div>
        </div>
        <div className={`training-readiness${planReady ? ' is-ready' : ''}`}>
          <strong>{planReady ? 'READY' : 'NOT READY'}</strong>
          <span>{planReady
            ? `Every configured class has at least ${sampleLimit.toLocaleString('en-US')} valid approved samples.`
            : `Training stays disabled until every configured class has at least ${sampleLimit.toLocaleString('en-US')} valid approved samples.`}</span>
        </div>
        {Number(dataset.already_exported_or_queued || 0) > 0 ? (
          <p className="train-empty">
            {dataset.already_exported_or_queued} review(s) have already been exported or assigned to a job. Samples from a finished training stay in the Roboflow project and no longer count here; only approved samples not yet trained count toward the next training.
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
            <TrainProgress job={latestJob} />
            {latestJob.error_message ? <p className="train-error">{latestJob.error_message}</p> : null}
            {formatMap(latestJob.metrics) ? (
              <p className="train-empty">Roboflow mAP {formatMap(latestJob.metrics)}</p>
            ) : null}
            {latestJob.status === 'failed' ? (
              <p className="train-empty">
                This job failed, so the cameras still use the current best.onnx.
                Retry the same reviews, or clear the job to hide this card and put the unused reviews back in the training pool.
              </p>
            ) : null}
            {latestJob.status === 'deployed' ? (
              <p className="train-empty">
                Training finished. Evaluate the model and approve deployment before replacing the active weights. Clear this card to hide the completed job; its dataset snapshot remains saved.
              </p>
            ) : null}
            {latestJob.status === 'rejected' ? (
              <p className="train-empty">
                This trained version was rejected. The live cameras were not changed. Clear the job to hide this card.
              </p>
            ) : null}
            {latestJob.status === 'awaiting_evaluation' || latestJob.status === 'completed' ? (
              <label className="train-notes">
                Evaluation notes
                <textarea value={evalNotes} onChange={(event) => setEvalNotes(event.target.value)} rows={2} />
              </label>
            ) : null}
            <div className="train-actions">
              {latestJob.status === 'failed' ? (
                <button className="deck-btn" type="button" disabled={busy} onClick={() => runTrainingAction({
                  title: 'Retry this job',
                  message: 'Retry the last failed step. Upload runs again if images are missing. If upload already finished, pick your data again.',
                  confirmLabel: 'Retry',
                  success: 'Retry started.',
                  action: () => retryTrainingJob(latestJob.id),
                  key: 'retry',
                })}>Retry</button>
              ) : null}
              {CLEARABLE_JOB.includes(latestJob.status) ? (
                <button className="deck-btn" type="button" disabled={busy} onClick={() => runTrainingAction({
                  title: latestJob.status === 'failed' ? 'Clear failed job?' : 'Clear this job from the panel?',
                  message: latestJob.status === 'failed'
                    ? 'Hide this failed job. Reviews that never reached Roboflow training return to Eligible for training so you can upload again.'
                    : 'Hide this finished job so you can start a new upload. Used reviews stay out of the next dataset. The live model is not changed.',
                  confirmLabel: 'Clear job',
                  success: 'Job cleared from the panel.',
                  action: () => dismissTrainingJob(latestJob.id),
                  key: 'dismiss',
                })}>Clear job</button>
              ) : null}
              {latestJob.status === 'ready_to_pick' ? (
                <div className="train-recipe">
                  <div>
                    <strong>Pick your data</strong>
                    <span>Train {latestJob.train_count ?? 0} · Valid {latestJob.valid_count ?? 0}</span>
                    <p>
                      Architecture is locked to YOLOv11 Large. This creates a Roboflow version from the uploaded reviews using those splits.
                      Training still waits until you start 350 epochs.
                    </p>
                  </div>
                  <button
                    className="deck-btn primary"
                    type="button"
                    disabled={busy}
                    onClick={() => runTrainingAction({
                      title: 'Pick this uploaded dataset?',
                      message: `Use ${latestJob.uploaded_count}/${latestJob.item_count} uploaded images (train ${latestJob.train_count ?? 0}, valid ${latestJob.valid_count ?? 0}) to create the Roboflow version.`,
                      confirmLabel: 'Pick data',
                      success: 'Dataset version created. Start YOLOv11 Large training at 350 epochs.',
                      action: () => pickTrainingData(latestJob.id),
                      key: 'pick-data',
                    })}
                  >
                    Pick your data
                  </button>
                </div>
              ) : null}
              {latestJob.status === 'ready_to_train' ? (
                <div className="train-recipe">
                  <div>
                    <strong>{training?.recipe?.engine_label || 'Custom Training'}</strong>
                    <span>
                      {(training?.recipe?.architecture_label || 'YOLOv11')}
                      {' · '}
                      {(training?.recipe?.model_size_label || 'Large')}
                      {' · '}
                      {latestJob.epochs || training?.recipe?.epochs || 350} epochs
                    </span>
                    <p>
                      Version {latestJob.dataset_version || '—'} is ready. Architecture and epochs are fixed.
                      When Roboflow finishes, the trained weights are downloaded and connected to the cameras. A backup of the current best.onnx is kept.
                    </p>
                  </div>
                  <button
                    className="deck-btn primary"
                    type="button"
                    disabled={busy}
                    onClick={() => runTrainingAction({
                      title: 'Start YOLOv11 Large training?',
                      message: 'Roboflow will train YOLOv11 Large for 350 epochs on the version you picked. The active weights stay in place until the trained model is evaluated and deployment is approved.',
                      confirmLabel: 'Start training',
                      success: 'Training started on Roboflow (YOLOv11 Large, 350 epochs). An administrator must evaluate and approve deployment before the active model changes.',
                      action: () => startRoboflowRecipe(latestJob.id, {
                        architecture: training?.recipe?.architecture || 'yolov11',
                        model_size: training?.recipe?.model_size || 'large',
                        epochs: latestJob.epochs || training?.recipe?.epochs || 350,
                      }),
                      key: 'start-recipe',
                    })}
                  >
                    Start training
                  </button>
                </div>
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
                    message: 'This records approval only. Deploy downloads the weights and connects them to the cameras.',
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
                  title: 'Deploy trained weights',
                  message: 'Download the trained weights from Roboflow, install them as the live camera model, and keep a backup of the current one. The 14 classes must still match.',
                  confirmLabel: 'Deploy',
                  success: (result) => result?.message || 'The trained weights are installed. The cameras use them when the detector is running.',
                  action: () => deployTrainingJob(latestJob.id),
                  key: 'deploy',
                })}>Record deployment</button>
              ) : null}
              {latestJob.status === 'deployed' && latestJob.backup_model_path ? (
                <button className="deck-btn" type="button" disabled={busy} onClick={() => runTrainingAction({
                  title: 'Roll back ONNX',
                  message: 'Restore the previous local best.onnx backup.',
                  confirmLabel: 'Roll back',
                  success: (result) => result?.message || 'Previous local model restored.',
                  action: () => rollbackTrainingJob(latestJob.id),
                  key: 'rollback',
                })}>Roll back</button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="train-empty">No training jobs yet. Approve reviews, include them in training, then upload the dataset. Next you pick the data and train YOLOv11 Large for 350 epochs.</p>
        )}
      </section>

      <div className="stat-row missed-stats">
        <StatCard
          label="Waiting"
          value={counts.pending}
          hint="Click to show reviews that still need a decision"
          active={filters.status === 'pending' && !filters.for_training}
          onClick={() => setFilter({
            status: filters.status === 'pending' && !filters.for_training ? '' : 'pending',
            for_training: false,
          })}
        />
        <StatCard
          label="Corrected"
          value={Number(counts.corrected || 0) + Number(counts.verified || 0)}
          hint="Corrected samples still need explicit approval before training"
          active={filters.status === 'corrected'}
          onClick={() => setFilter({
            status: filters.status === 'corrected' ? '' : 'corrected',
            for_training: false,
          })}
        />
        <StatCard
          label="Approved"
          value={counts.approved}
          hint="Click to open the class counts, and show approved reviews"
          active={filters.status === 'approved' && !filters.for_training}
          onClick={() => {
            const turningOn = !(filters.status === 'approved' && !filters.for_training);
            setFilter({ status: turningOn ? 'approved' : '', for_training: false });
            setApprovedClassOpen(turningOn);
          }}
        />
        <StatCard
          label="Rejected"
          value={counts.rejected}
          hint="Click to show reviews kept out of training"
          active={filters.status === 'rejected'}
          onClick={() => setFilter({
            status: filters.status === 'rejected' ? '' : 'rejected',
            for_training: false,
          })}
        />
        <StatCard
          label="Ready for training"
          value={counts.training_eligible}
          hint="Click to show approved reviews for the next upload"
          active={filters.for_training}
          onClick={() => setFilter({ status: '', for_training: !filters.for_training })}
        />
      </div>

      <Modal
        open={approvedClassOpen}
        onClose={() => setApprovedClassOpen(false)}
        labelledBy="approved-class-title"
      >
        <div className="modal-head">
          <h3 id="approved-class-title">Approved by class</h3>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            onClick={() => setApprovedClassOpen(false)}
          >
            ×
          </button>
        </div>
        <div className="modal-body approved-class-modal">
          <p>Live counts include valid approved samples. Training requires {sampleLimit.toLocaleString('en-US')} per class.</p>
          {isAdmin ? <div className={`approved-class-limit${sampleLimitSaving ? ' is-saving' : ''}`} aria-busy={sampleLimitSaving}>
            <FilterSelect
              id="approved-class-limit"
              label="Approved samples per class"
              value={String(sampleLimit)}
              options={SAMPLE_LIMIT_OPTIONS.map((count) => ({
                value: String(count),
                label: `${count.toLocaleString('en-US')} approved samples per class`,
              }))}
              onChange={changeSampleLimit}
            />
          </div> : null}
          <div className="approved-class-table-wrap" role="region" aria-label="Approved sample counts by waste class" tabIndex={0}>
            <table className="approved-class-table">
              <thead>
                <tr><th scope="col">Waste class</th><th scope="col">Approved samples</th><th scope="col">Required</th><th scope="col">Status</th></tr>
              </thead>
              <tbody>
                {approvedRows.map((row) => (
                  <tr key={row.name}>
                    <th scope="row">{row.name}</th>
                    <td>{Number(row.eligible || 0).toLocaleString('en-US')}</td>
                    <td>{row.optional ? '—' : `${sampleLimit.toLocaleString('en-US')}${row.remaining > 0 ? ` · need ${Number(row.remaining).toLocaleString('en-US')}` : ''}`}</td>
                    <td>
                      {row.optional ? (
                        <span className="approved-class-status is-optional" title="New class: label samples to include it in training">New · optional</span>
                      ) : (
                        <span className={`approved-class-status${row.remaining > 0 ? '' : ' is-ready'}`}>{row.remaining > 0 ? 'Waiting' : 'Ready'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>

      <section className="review-find" aria-label="Filter reviews">
        <div className="review-find-row">
          <FilterSelect
            id="missed-camera"
            label="Camera"
            value={filters.camera_id}
            options={[
              { value: '', label: 'Any camera' },
              ...realCameras.map((cam) => ({ value: cam.id, label: cam.name ? `${cam.id} · ${cam.name}` : cam.id })),
            ]}
            onChange={(value) => setFilter({ camera_id: value })}
          />
          <FilterSelect
            id="missed-class"
            label="Waste type"
            value={filters.class_name}
            options={[
              { value: '', label: 'Any waste type' },
              ...classOptions.map((name) => ({ value: name, label: name })),
            ]}
            onChange={(value) => setFilter({ class_name: value })}
          />
          <button
            type="button"
            className={`review-find-toggle${showMoreFilters || filters.from || filters.to || filters.confidence ? ' is-on' : ''}`}
            aria-expanded={showMoreFilters}
            onClick={() => setShowMoreFilters((open) => !open)}
          >
            {showMoreFilters ? 'Hide date and confidence' : 'Date and confidence'}
          </button>
          {filtersActive ? (
            <button type="button" className="review-find-clear" onClick={clearFilters}>
              Clear
            </button>
          ) : null}
        </div>
        {showMoreFilters ? (
          <div className="review-find-more">
            <FilterSelect
              id="missed-conf"
              label="AI confidence"
              value={filters.confidence}
              options={[
                { value: '', label: 'Any score' },
                { value: 'lt60', label: 'Under 60%' },
                { value: '60-80', label: '60% to 79%' },
                { value: 'gte80', label: '80% or higher' },
              ]}
              onChange={(value) => setFilter({ confidence: value })}
            />
            <div className="filter-field">
              <label htmlFor="missed-from">Detected from</label>
              <input id="missed-from" type="date" value={filters.from} onChange={(event) => setFilter({ from: event.target.value })} />
            </div>
            <div className="filter-field">
              <label htmlFor="missed-to">Detected until</label>
              <input id="missed-to" type="date" value={filters.to} onChange={(event) => setFilter({ to: event.target.value })} />
            </div>
          </div>
        ) : null}
        <p className="review-find-summary">{filterSummary}</p>
      </section>

      <section className="panel det-table-panel">
        <div className="panel-head">
          <span className="panel-title">
            Review queue · <b>{loading && reports.length === 0 ? '…' : meta.total}</b>
          </span>
          <div className="det-table-tools review-queue-tools">
            <TableSelectAll
              allSelected={allSelected}
              someSelected={someSelected}
              disabled={totalRows === 0 || busy || selectingAll}
              onToggle={toggleAll}
              count={selectedCount}
              label={selectingAll ? 'Selecting…' : undefined}
            />
            <button
              type="button"
              className="deck-btn"
              disabled={!isAdmin || selectedCount === 0 || busy}
              onClick={removeSelectedReports}
            >
              {selectedCount > 0 ? `Delete selected (${selectedCount})` : 'Delete selected'}
            </button>
          </div>
        </div>
        <div className="det-table-wrap">
          <table className="det-table">
            <thead>
              <tr>
                {/* Selecting every review is done with the Select all button above. */}
                <th className="det-select-col" aria-label="Select" />
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
                  <td className="det-table-empty" colSpan={9}>
                    <div className="review-error">
                      <span>{error || 'The review queue could not be loaded.'}</span>
                      <button className="deck-btn" type="button" onClick={() => load()}>Retry</button>
                    </div>
                  </td>
                </tr>
              ) : null}
              {!loading && !error && reports.length === 0 ? (
                <tr>
                  <td className="det-table-empty" colSpan={9}>
                    Nothing matches. Clear the filters, or search another review number, camera, or waste type.
                  </td>
                </tr>
              ) : null}
              {!error ? reports.map((row) => {
                const elig = trainingEligibility(row);
                const checked = selectedIds.has(row.id);
                return (
                  <tr key={row.id} className={row.id === selectedId || checked ? 'is-selected' : ''}>
                    <td className="det-select-col">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        aria-label={`Select review ${row.id}`}
                        onChange={() => toggleRow(row.id)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </td>
                    <td>
                      <button type="button" className="det-snap-btn" onClick={() => setSelectedId(row.id)} aria-label={`Open review ${row.id}`}>
                        {row.thumb_url || row.image_url ? (
                          <img
                            src={row.thumb_url || row.image_url}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            width="64"
                            height="48"
                          />
                        ) : null}
                      </button>
                    </td>
                    <td>
                      <span className="waste-type-stack">
                        <span className="waste-cat">{row.annotations?.[0]?.class_name || row.prediction || 'None'}</span>
                        <span className="waste-sub">
                          {`Review ${row.id} · ${row.annotations?.[0]?.class_name
                            ? (row.prediction && row.prediction !== row.annotations[0].class_name
                              ? `replaced ${row.prediction}`
                              : 'admin class')
                            : 'AI prediction'}`}
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
        <TablePager
          id="review-page-size"
          page={currentPage}
          lastPage={lastPage}
          total={totalRows}
          pageSize={rowsPerPage}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            savePageSize('tidalwatch-review-page-size', size);
            setRowsPerPage(size);
            setPage(1);
          }}
        />
      </section>

      <Modal open={Boolean(selected)} onClose={() => setSelectedId(null)} labelledBy="missed-review-title">
        {selected ? (
        <div className="missed-modal">
          <div className="modal-head">
            <h3 id="missed-review-title">Review {selected.id} · <span>{selected.camera_name || selected.camera_id}</span></h3>
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
              <p className="waste-cat">{selected.original_prediction || selected.prediction || 'None'}</p>
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
                {classOptions.map((name, index) => (
                  <option key={name} value={name}>{index} · {name}</option>
                ))}
              </select>
              {isAdmin ? (
                <div className="catalog-actions">
                  <button type="button" className="mini-link" onClick={() => setAddKind('category')}>
                    Add category
                  </button>
                  <button type="button" className="mini-link" onClick={() => setAddKind('classification')}>
                    Add classification
                  </button>
                </div>
              ) : null}
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
                    {(classOptions.includes(box.class_name) ? classOptions : [box.class_name, ...classOptions]).map((name) => (
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
                <button className="deck-btn" type="button" onClick={() => review('corrected')} disabled={busy} aria-busy={busyAction === 'corrected'}>
                  {busyAction === 'corrected' ? 'Saving…' : 'Mark corrected'}
                </button>
                <button className="deck-btn primary" type="button" onClick={() => review('approved', true)} disabled={busy} aria-busy={busyAction === 'approve'}>
                  {busyAction === 'approve' ? 'Approving…' : 'Approve Review'}
                </button>
                <button className="deck-btn" type="button" onClick={() => review('rejected')} disabled={busy} aria-busy={busyAction === 'reject'}>
                  {busyAction === 'reject' ? 'Rejecting…' : 'Reject Review'}
                </button>
              </div>
            ) : null}
            {isAdmin && ['verified', 'corrected'].includes(selected.status) ? (
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
                {!selected.training_job_id ? (
                  <button
                    className="deck-btn"
                    type="button"
                    onClick={() => review('corrected')}
                    disabled={busy}
                    aria-busy={busyAction === 'corrected'}
                  >
                    Revoke approval to edit
                  </button>
                ) : null}
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
      <AddWasteModal
        open={Boolean(addKind)}
        kind={addKind || 'category'}
        stacked
        onClose={() => setAddKind(null)}
        onCreated={({ kind, name }) => {
          if (kind === 'classification' && name) setDrawClass(name);
        }}
      />
    </div>
  );
}
