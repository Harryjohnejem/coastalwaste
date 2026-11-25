import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from '../common/Modal';
import Switch from '../common/Switch';
import RangeField from '../common/RangeField';
import FilterSelect from '../common/FilterSelect';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useClassesStore } from '../../stores/useClassesStore';
import { useCameraStore } from '../../stores/useCameraStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { useNavStore } from '../../stores/useNavStore';
import { confirmAction, notice, actionErrorMessage } from '../../stores/useNoticeStore';
import {
  DEFAULT_RECORDING_SECONDS,
  LIVE_DETECTION_CLASSES,
  LIVE_MODEL_NAME,
  RECORDING_LENGTH_OPTIONS,
} from '../../constants';
import AddWasteModal from '../detections/AddWasteModal';

const TABS = [
  { id: 'camera', label: 'Cameras', icon: 'cam' },
  { id: 'detection', label: 'Detection', icon: 'det' },
  { id: 'recording', label: 'Recording', icon: 'rec' },
  { id: 'alerts', label: 'Notifications', icon: 'alert' },
  { id: 'system', label: 'Station', icon: 'sys' },
  { id: 'catalog', label: 'Waste catalog', icon: 'catalog' },
];

function TabIcon({ name }) {
  if (name === 'cam') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M23 7l-7 5 7 5V7z" />
        <rect x="1" y="5" width="15" height="14" rx="2" />
      </svg>
    );
  }
  if (name === 'det') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2" />
      </svg>
    );
  }
  if (name === 'rec') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    );
  }
  if (name === 'alert') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M10.3 21a2 2 0 003.4 0" />
      </svg>
    );
  }
  if (name === 'catalog') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M4 7h16M4 12h16M4 17h10" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

export default function SettingsModal() {
  const navigate = useNavigate();
  const open = useSettingsStore((s) => s.settingsOpen);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const settings = useSettingsStore((s) => s.settings);
  // Re-render when the live class list changes (a deployed model with new classes).
  useClassesStore((s) => s.version);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const settingsSaving = useSettingsStore((s) => s.settingsSaving);
  const settingsLoading = useSettingsStore((s) => s.settingsLoading);
  const settingsTab = useSettingsStore((s) => s.settingsTab);
  const wasteCatalog = useSettingsStore((s) => s.wasteCatalog);
  const fetchWasteCatalog = useSettingsStore((s) => s.fetchWasteCatalog);
  const cameras = useCameraStore((s) => s.cameras);
  const logout = useAuthStore((s) => s.logout);
  const setModule = useNavStore((s) => s.setModule);

  const [tab, setTab] = useState('camera');
  const [form, setForm] = useState(settings);
  const [addKind, setAddKind] = useState(null);
  const hydratedRef = useRef(false);

  const handleLogout = async () => {
    const accepted = await confirmAction({
      title: 'Log out?',
      message: 'You will need to sign in again to use the monitoring station.',
      confirmLabel: 'Log out',
      variant: 'warning',
    });
    if (!accepted) return;
    closeSettings();
    logout();
    navigate('/login', { replace: true });
  };

  // Opening Settings reloads them, so the Model line names the model the
  // cameras run now (it changes on Deploy and Rollback, e.g. "local-ruwza-dgl85 v5").
  useEffect(() => {
    if (open) useSettingsStore.getState().fetchSettings();
  }, [open]);

  useEffect(() => {
    if (!open) {
      hydratedRef.current = false;
      return undefined;
    }
    if (hydratedRef.current) return undefined;
    if (settingsLoading) return undefined;
    hydratedRef.current = true;
    setForm({
      ...settings,
      detection: {
        ...settings.detection,
        classes: [...LIVE_DETECTION_CLASSES],
        model: LIVE_MODEL_NAME,
      },
      recording: {
        record_confidence: 0.8,
        track_lost_timeout: 3,
        prevent_duplicate: true,
        ...settings.recording,
      },
      station: {
        ...settings.station,
        name: settings.station?.name || 'Brgy. Gracia',
      },
    });
    const nextTab =
      typeof settingsTab === 'string' && TABS.some((t) => t.id === settingsTab)
        ? settingsTab
        : 'camera';
    setTab(nextTab);
    return undefined;
  }, [open, settings, settingsLoading, settingsTab]);

  useEffect(() => {
    if (!open || tab !== 'catalog') return undefined;
    fetchWasteCatalog();
    return undefined;
  }, [open, tab, fetchWasteCatalog]);

  const patch = (section, key, value) => {
    setForm((f) => ({
      ...f,
      [section]: { ...f[section], [key]: value },
    }));
  };

  const openCameras = () => {
    closeSettings();
    setModule('cameras');
  };

  const handleSave = async () => {
    const detectionConf = Math.min(0.98, Math.max(0.8, Number(form.detection?.confidence ?? 0.8)));
    const reviewConf = Math.min(0.79, Math.max(0.25, Number(form.detection?.review_confidence ?? 0.6)));
    const recordConf = Math.min(0.98, Math.max(0.8, Number(form.recording?.record_confidence ?? 0.8)));
    const stationName = String(form.station?.name || '').trim() || 'Brgy. Gracia';
    const accepted = await confirmAction({
      title: 'Save configuration?',
      message: 'Detection, recording, and station settings will be updated for this station.',
      confirmLabel: 'Save',
    });
    if (!accepted) return;
    const payload = {
      ...form,
      detection: {
        ...form.detection,
        confidence: detectionConf,
        review_confidence: reviewConf,
        classes: [...LIVE_DETECTION_CLASSES],
        model: LIVE_MODEL_NAME,
      },
      recording: { ...form.recording, record_confidence: recordConf },
      station: { ...form.station, name: stationName },
    };
    // Apply at once and close; the server save runs in the background.
    // The API serves one request at a time, so waiting here felt slow.
    const previous = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      settings: {
        ...previous,
        ...payload,
        detection: { ...previous.detection, ...payload.detection, enabled: previous.detection?.enabled },
      },
    });
    closeSettings();
    notice.info('Saving configuration', 'Your changes are applied. Saving them to the station…');
    try {
      const ok = await saveSettings(payload);
      if (!ok) throw new Error(useSettingsStore.getState().settingsError || 'Could not save settings.');
      notice.success('Configuration saved', 'Detection, recording, and station settings were updated.');
    } catch (err) {
      useSettingsStore.setState({ settings: previous });
      notice.error('Configuration not saved', actionErrorMessage(err, 'Could not save settings. Your previous settings are back.'));
    }
  };

  return (
    <Modal open={open} onClose={closeSettings} labelledBy="settings-title">
      <div className="modal-head">
        <h3 id="settings-title">
          System <span>configuration</span>
        </h3>
        <button className="modal-close" type="button" aria-label="Close settings" onClick={closeSettings}>
          ✕
        </button>
      </div>

      <div className="modal-body">
        <nav className="tabs" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <TabIcon name={t.icon} />
              {t.label}
            </button>
          ))}
        </nav>

        <div className="tab-panes">
          {tab === 'camera' && (
            <div className="pane active">
              <h4>Live cameras</h4>
              <div className="hint" style={{ marginBottom: 14 }}>
                The two wide cameras are configured in Cameras. The stream address,
                protocol, and connection test are saved on the camera, not in this dialog.
              </div>
              {cameras.length === 0 ? (
                <div className="catalog-empty">No cameras are loaded yet.</div>
              ) : (
                <ul className="catalog-list">
                  {cameras.map((camera) => (
                    <li key={camera.id} className="catalog-item">
                      <strong>{camera.name || camera.id}</strong>
                      <p>{camera.location || camera.sector || 'Paco Beach'}</p>
                    </li>
                  ))}
                </ul>
              )}
              <div className="field">
                <button className="test-btn" type="button" onClick={openCameras}>
                  Open Cameras
                </button>
              </div>
            </div>
          )}

          {tab === 'detection' && (
            <div className="pane active">
              <h4>Model</h4>
              <div className="field">
                <div className="sw-label">{settings.live_model?.label || LIVE_MODEL_NAME}</div>
                <div className="hint">This is the model running on the live cameras. It is not switched from here.</div>
              </div>
              <div className="field">
                <label htmlFor="cfg-conf">Detection confidence</label>
                <RangeField
                  id="cfg-conf"
                  min={80}
                  max={98}
                  value={Math.round((form.detection?.confidence ?? 0.8) * 100)}
                  format={(v) => `${v}%`}
                  onChange={(v) => patch('detection', 'confidence', v / 100)}
                />
                <div className="hint">A box is drawn when a dataset class reaches this score. The label shows the highest score that object reaches.</div>
              </div>
              <div className="field">
                <label htmlFor="cfg-review-conf">Review confidence</label>
                <RangeField
                  id="cfg-review-conf"
                  min={25}
                  max={79}
                  value={Math.round((form.detection?.review_confidence ?? 0.6) * 100)}
                  format={(v) => `${v}%`}
                  onChange={(v) => patch('detection', 'review_confidence', v / 100)}
                />
                <div className="hint">Scores from this line up to 79% are saved to Detection Reviews automatically (default 60–79%). They are not saved as waste detections; 80% and up go to Waste Detections.</div>
              </div>
              <h4>Dataset classes</h4>
              <div className="hint" style={{ marginBottom: 14 }}>
                The live model detects these {LIVE_DETECTION_CLASSES.length} classes on every camera. A class cannot be turned off from here.
              </div>
              <div className="catalog-chips">
                {LIVE_DETECTION_CLASSES.map((name) => (
                  <span key={name} className="catalog-chip">{name}</span>
                ))}
              </div>
              <h4>Overlay</h4>
              <div className="switch-row">
                <div>
                  <div className="sw-label">Show bounding boxes</div>
                  <div className="sw-sub">Draw detection boxes on the live camera</div>
                </div>
                <Switch
                  checked={form.detection?.showBoxes !== false}
                  onChange={(v) => patch('detection', 'showBoxes', v)}
                />
              </div>
              <div className="switch-row">
                <div>
                  <div className="sw-label">Show confidence scores</div>
                  <div className="sw-sub">Show the highest percentage on each box</div>
                </div>
                <Switch
                  checked={form.detection?.showConfidence !== false}
                  onChange={(v) => patch('detection', 'showConfidence', v)}
                />
              </div>
            </div>
          )}

          {tab === 'recording' && (
            <div className="pane active">
              <h4>When a detection is saved</h4>
              <div className="field">
                <label htmlFor="cfg-record-conf">Record confidence</label>
                <RangeField
                  id="cfg-record-conf"
                  min={80}
                  max={98}
                  value={Math.round((form.recording?.record_confidence ?? 0.8) * 100)}
                  format={(v) => `${v}%`}
                  onChange={(v) => patch('recording', 'record_confidence', v / 100)}
                />
                <div className="hint">A row is written on the first look at or above this score. The stored percentage is the highest score that object reaches. A later higher look updates the same row.</div>
              </div>
              <div className="field">
                <label htmlFor="cfg-track-timeout">Track lost timeout</label>
                <RangeField
                  id="cfg-track-timeout"
                  min={1}
                  max={15}
                  value={form.recording?.track_lost_timeout ?? 3}
                  format={(v) => `${v}s`}
                  onChange={(v) => patch('recording', 'track_lost_timeout', v)}
                />
                <div className="hint">How long a missing object stays the same track before a new sighting can be saved.</div>
              </div>
              <div className="switch-row">
                <div>
                  <div className="sw-label">Prevent duplicate recordings</div>
                  <div className="sw-sub">Keep one Waste Detections row for each tracked object</div>
                </div>
                <Switch
                  checked={form.recording?.prevent_duplicate !== false}
                  onChange={(v) => patch('recording', 'prevent_duplicate', v)}
                />
              </div>
              <div className="switch-row">
                <div>
                  <div className="sw-label">Save detection snapshots</div>
                  <div className="sw-sub">Store an image with each saved detection</div>
                </div>
                <Switch
                  checked={form.station?.saveSnapshots !== false}
                  onChange={(v) => patch('station', 'saveSnapshots', v)}
                />
              </div>

              <h4>Recording option</h4>
              <div className="switch-row recording-length-row">
                <div className="recording-length-text">
                  <div className="sw-label">Clip recording length</div>
                  <div className="sw-sub">
                    The Record button on Live Monitoring stops and saves the clip after this time.
                    Tap Stop to end it sooner.
                  </div>
                </div>
                <div className="recording-length-select">
                  <FilterSelect
                    id="recording-length"
                    value={String(form.recording?.clip_max_seconds ?? DEFAULT_RECORDING_SECONDS)}
                    options={RECORDING_LENGTH_OPTIONS.map((o) => ({
                      value: String(o.seconds),
                      label: o.label,
                    }))}
                    onChange={(v) => patch('recording', 'clip_max_seconds', Number(v))}
                  />
                </div>
              </div>
            </div>
          )}

          {tab === 'alerts' && (
            <div className="pane active">
              <h4>Notifications</h4>
              <div className="hint">
                The bell in the top bar lists cleanup alerts and other notices for the administrator.
              </div>
              <div className="switch-row">
                <div>
                  <div className="sw-label">Notify on every new detection</div>
                  <div className="sw-sub">One notice per saved waste record (class, camera, location). Off keeps the bell for cleanup alerts.</div>
                </div>
                <Switch
                  checked={form.alerts?.detectionAlerts === true}
                  onChange={(v) => patch('alerts', 'detectionAlerts', v)}
                />
              </div>
              <h4>Cleanup threshold</h4>
              <div className="switch-row">
                <div>
                  <div className="sw-label">Cleanup alerts</div>
                  <div className="sw-sub">Warn when waste still on the beach builds up, and alert when a camera is full</div>
                </div>
                <Switch
                  checked={form.alerts?.densityAlerts !== false}
                  onChange={(v) => patch('alerts', 'densityAlerts', v)}
                />
              </div>
              <div className="field">
                <label htmlFor="cfg-cleanup-limit">Cleanup limit per camera</label>
                <RangeField
                  id="cfg-cleanup-limit"
                  min={5}
                  max={100}
                  value={Number(form.alerts?.cleanupLimit ?? 20)}
                  format={(v) => `${v} items`}
                  onChange={(v) => patch('alerts', 'cleanupLimit', v)}
                />
                <div className="hint">When this many waste items are still on the beach in one camera view, the camera is full and a cleanup team is needed.</div>
              </div>
              <div className="field">
                <label htmlFor="cfg-cleanup-warn">Warning level</label>
                <RangeField
                  id="cfg-cleanup-warn"
                  min={50}
                  max={95}
                  value={Number(form.alerts?.densityThreshold ?? 70)}
                  format={(v) => `${v}%`}
                  onChange={(v) => patch('alerts', 'densityThreshold', v)}
                />
                <div className="hint">
                  An early warning at {Math.max(1, Math.ceil((Number(form.alerts?.cleanupLimit ?? 20) * Number(form.alerts?.densityThreshold ?? 70)) / 100))} items, so the team can plan before the beach is full.
                </div>
              </div>
            </div>
          )}

          {tab === 'system' && (
            <div className="pane active">
              <h4>Station identity</h4>
              <div className="field">
                <label htmlFor="cfg-station">Station name</label>
                <input
                  type="text"
                  id="cfg-station"
                  value={form.station?.name || ''}
                  onChange={(e) => patch('station', 'name', e.target.value)}
                />
                <div className="hint">Shown in the top bar. Each camera keeps its own location, such as Paco Beach.</div>
              </div>
            </div>
          )}

          {tab === 'catalog' && (
            <div className="pane active">
              <h4>Waste categories and classifications</h4>
              <div className="hint" style={{ marginBottom: 14 }}>
                Saved names appear in Waste Detections, Detection Reviews, and reports. They do not
                change the {LIVE_DETECTION_CLASSES.length} classes the live model detects. Add a category first, then add
                classifications under it.
              </div>
              <div className="catalog-actions">
                <button className="test-btn" type="button" onClick={() => setAddKind('category')}>
                  Add waste category
                </button>
                <button
                  className="test-btn"
                  type="button"
                  onClick={() => setAddKind('classification')}
                  disabled={wasteCatalog.length === 0}
                >
                  Add waste classification
                </button>
              </div>
              {wasteCatalog.length === 0 ? (
                <div className="catalog-empty">No saved categories yet. Add one to get started.</div>
              ) : (
                <ul className="catalog-list">
                  {wasteCatalog.map((cat) => (
                    <li key={cat.id} className="catalog-item">
                      <strong>{cat.name}</strong>
                      {cat.description ? <p>{cat.description}</p> : null}
                      <div className="catalog-chips">
                        {(cat.classifications || []).length === 0 ? (
                          <span className="catalog-chip muted">No classifications</span>
                        ) : (
                          cat.classifications.map((row) => (
                            <span key={row.id} className="catalog-chip">
                              {row.name}
                            </span>
                          ))
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="modal-foot">
        <div className="foot-left">
          <button className="btn-danger" type="button" onClick={handleLogout}>
            Log out
          </button>
        </div>
        <button className="btn-ghost" type="button" onClick={closeSettings}>
          Cancel
        </button>
        <button
          className="btn-save"
          type="button"
          onClick={handleSave}
          disabled={settingsSaving}
        >
          {settingsSaving ? 'Saving…' : 'Save configuration'}
        </button>
      </div>
      <AddWasteModal
        open={Boolean(addKind)}
        kind={addKind || 'category'}
        stacked
        onClose={() => setAddKind(null)}
      />
    </Modal>
  );
}
