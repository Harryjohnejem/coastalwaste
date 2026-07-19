import { useEffect, useState } from 'react';
import Modal from '../common/Modal';
import Switch from '../common/Switch';
import RangeField from '../common/RangeField';
import ChipSet from '../common/ChipSet';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useCameraStore } from '../../stores/useCameraStore';

const CLASS_OPTIONS = [
  'Plastic bottles',
  'Plastic bags',
  'Fishing nets',
  'Styrofoam',
  'Metal cans',
  'Glass',
  'Rubber / tires',
  'Organic debris',
];

const TABS = [
  { id: 'camera', label: 'Camera source', icon: 'cam' },
  { id: 'detection', label: 'Detection', icon: 'det' },
  { id: 'alerts', label: 'Alerts & reports', icon: 'alert' },
  { id: 'system', label: 'Station & storage', icon: 'sys' },
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
  if (name === 'alert') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M10.3 21a2 2 0 003.4 0" />
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

export default function SettingsModal({ onTestStream }) {
  const open = useSettingsStore((s) => s.settingsOpen);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const setStreamStatus = useCameraStore((s) => s.setStreamStatus);

  const [tab, setTab] = useState('camera');
  const [form, setForm] = useState(settings);
  const [testError, setTestError] = useState('');

  useEffect(() => {
    if (open) {
      setForm(settings);
      setTab('camera');
      setTestError('');
    }
  }, [open, settings]);

  const patch = (section, key, value) => {
    setForm((f) => ({
      ...f,
      [section]: { ...f[section], [key]: value },
    }));
  };

  const handleTest = () => {
    setTestError('');
    const url = form.stream?.url?.trim();
    if (!url) {
      setTestError('Set a camera stream URL before testing.');
      return;
    }
    setStreamStatus('CONNECTING…');
    onTestStream?.(url, form.stream?.protocol);
  };

  const handleSave = () => {
    // TODO: POST config to your backend / persist to your store
    saveSettings(form);
  };

  const toggleClass = (label) => {
    const classes = form.detection?.classes || [];
    const next = classes.includes(label)
      ? classes.filter((c) => c !== label)
      : [...classes, label];
    patch('detection', 'classes', next);
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
              <h4>Stream source</h4>
              <div className="field">
                <label htmlFor="cfg-url">Camera stream URL</label>
                <input
                  type="text"
                  id="cfg-url"
                  placeholder="rtsp://user:pass@192.168.1.64:554/stream1"
                  value={form.stream?.url || ''}
                  onChange={(e) => patch('stream', 'url', e.target.value)}
                />
                <div className="hint">RTSP, HLS (.m3u8), MJPEG or HTTP snapshot endpoint</div>
              </div>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="cfg-protocol">Protocol</label>
                  <select
                    id="cfg-protocol"
                    value={form.stream?.protocol || 'RTSP (via gateway)'}
                    onChange={(e) => patch('stream', 'protocol', e.target.value)}
                  >
                    <option>RTSP (via gateway)</option>
                    <option>HLS</option>
                    <option>MJPEG</option>
                    <option>WebRTC</option>
                    <option>HTTP snapshot</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="cfg-transport">Transport</label>
                  <select
                    id="cfg-transport"
                    value={form.stream?.transport || 'TCP'}
                    onChange={(e) => patch('stream', 'transport', e.target.value)}
                  >
                    <option>TCP</option>
                    <option>UDP</option>
                    <option>Auto</option>
                  </select>
                </div>
              </div>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="cfg-user">Username</label>
                  <input
                    type="text"
                    id="cfg-user"
                    placeholder="admin"
                    value={form.stream?.username || ''}
                    onChange={(e) => patch('stream', 'username', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="cfg-pass">Password</label>
                  <input
                    type="password"
                    id="cfg-pass"
                    placeholder="••••••••"
                    value={form.stream?.password || ''}
                    onChange={(e) => patch('stream', 'password', e.target.value)}
                  />
                </div>
              </div>
              <h4>Video</h4>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="cfg-res">Resolution</label>
                  <select
                    id="cfg-res"
                    value={form.stream?.resolution || '1920 × 1080'}
                    onChange={(e) => patch('stream', 'resolution', e.target.value)}
                  >
                    <option>1920 × 1080</option>
                    <option>1280 × 720</option>
                    <option>2560 × 1440</option>
                    <option>3840 × 2160</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="cfg-fps">Frame rate</label>
                  <select
                    id="cfg-fps"
                    value={form.stream?.fps || '25 FPS'}
                    onChange={(e) => patch('stream', 'fps', e.target.value)}
                  >
                    <option>25 FPS</option>
                    <option>30 FPS</option>
                    <option>15 FPS</option>
                    <option>10 FPS</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <button className="test-btn" type="button" onClick={handleTest}>
                  Test connection
                </button>
                {testError && <div className="field-error">{testError}</div>}
              </div>
            </div>
          )}

          {tab === 'detection' && (
            <div className="pane active">
              <h4>Model</h4>
              <div className="field">
                <label htmlFor="cfg-model">Detection model</label>
                <select
                  id="cfg-model"
                  value={form.detection?.model || ''}
                  onChange={(e) => patch('detection', 'model', e.target.value)}
                >
                  <option>YOLO-COAST v2.1 (recommended)</option>
                  <option>YOLO-COAST v1.4</option>
                  <option>Custom ONNX model…</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="cfg-conf">Confidence threshold</label>
                <RangeField
                  id="cfg-conf"
                  min={10}
                  max={95}
                  value={Math.round((form.detection?.confidence ?? 0.6) * 100)}
                  format={(v) => (v / 100).toFixed(2)}
                  onChange={(v) => patch('detection', 'confidence', v / 100)}
                />
                <div className="hint">Detections below this score are ignored</div>
              </div>
              <div className="field">
                <label htmlFor="cfg-interval">Inference interval</label>
                <RangeField
                  id="cfg-interval"
                  min={1}
                  max={30}
                  value={form.detection?.interval ?? 5}
                  format={(v) => `${v} fr`}
                  onChange={(v) => patch('detection', 'interval', v)}
                />
                <div className="hint">Run detection every N frames to save compute</div>
              </div>
              <h4>Waste classes</h4>
              <div className="field">
                <ChipSet
                  options={CLASS_OPTIONS}
                  selected={form.detection?.classes || []}
                  onToggle={toggleClass}
                />
              </div>
              <h4>Overlay</h4>
              <div className="switch-row">
                <div>
                  <div className="sw-label">Show bounding boxes</div>
                  <div className="sw-sub">Draw detection boxes on the live feed</div>
                </div>
                <Switch
                  checked={form.detection?.showBoxes !== false}
                  onChange={(v) => patch('detection', 'showBoxes', v)}
                />
              </div>
              <div className="switch-row">
                <div>
                  <div className="sw-label">Show confidence scores</div>
                  <div className="sw-sub">Display model confidence on each label</div>
                </div>
                <Switch
                  checked={form.detection?.showConfidence !== false}
                  onChange={(v) => patch('detection', 'showConfidence', v)}
                />
              </div>
            </div>
          )}

          {tab === 'alerts' && (
            <div className="pane active">
              <h4>Alert triggers</h4>
              <div className="switch-row">
                <div>
                  <div className="sw-label">Density threshold alerts</div>
                  <div className="sw-sub">Notify when sector debris density exceeds limit</div>
                </div>
                <Switch
                  checked={form.alerts?.densityAlerts !== false}
                  onChange={(v) => patch('alerts', 'densityAlerts', v)}
                />
              </div>
              <div className="field">
                <label htmlFor="cfg-density">Density threshold</label>
                <RangeField
                  id="cfg-density"
                  min={10}
                  max={100}
                  value={form.alerts?.densityThreshold ?? 70}
                  format={(v) => `${v}%`}
                  onChange={(v) => patch('alerts', 'densityThreshold', v)}
                />
              </div>
              <div className="switch-row">
                <div>
                  <div className="sw-label">Large-item alerts</div>
                  <div className="sw-sub">Immediate alert for nets, drums, tires</div>
                </div>
                <Switch
                  checked={form.alerts?.largeItemAlerts !== false}
                  onChange={(v) => patch('alerts', 'largeItemAlerts', v)}
                />
              </div>
              <div className="switch-row">
                <div>
                  <div className="sw-label">Camera offline alerts</div>
                  <div className="sw-sub">Notify when a stream drops for &gt; 60 s</div>
                </div>
                <Switch
                  checked={form.alerts?.offlineAlerts !== false}
                  onChange={(v) => patch('alerts', 'offlineAlerts', v)}
                />
              </div>
              <h4>Report delivery</h4>
              <div className="field">
                <label htmlFor="cfg-email">Recipient email</label>
                <input
                  type="text"
                  id="cfg-email"
                  placeholder="coastal-team@example.org"
                  value={form.alerts?.email || ''}
                  onChange={(e) => patch('alerts', 'email', e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="cfg-webhook">Webhook URL (optional)</label>
                <input
                  type="text"
                  id="cfg-webhook"
                  placeholder="https://hooks.example.org/coastal-alerts"
                  value={form.alerts?.webhook || ''}
                  onChange={(e) => patch('alerts', 'webhook', e.target.value)}
                />
                <div className="hint">POST JSON payload on every alert event</div>
              </div>
              <div className="field">
                <label htmlFor="cfg-report-freq">Automatic summary report</label>
                <select
                  id="cfg-report-freq"
                  value={form.alerts?.reportFrequency || 'Daily · 06:00'}
                  onChange={(e) => patch('alerts', 'reportFrequency', e.target.value)}
                >
                  <option>Daily · 06:00</option>
                  <option>Every 12 hours</option>
                  <option>Weekly · Monday</option>
                  <option>Off</option>
                </select>
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
              </div>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="cfg-lat">Latitude</label>
                  <input
                    type="text"
                    id="cfg-lat"
                    value={form.station?.lat || ''}
                    onChange={(e) => patch('station', 'lat', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="cfg-lon">Longitude</label>
                  <input
                    type="text"
                    id="cfg-lon"
                    value={form.station?.lon || ''}
                    onChange={(e) => patch('station', 'lon', e.target.value)}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="cfg-tz">Timezone</label>
                <select
                  id="cfg-tz"
                  value={form.station?.timezone || 'Asia/Manila (UTC+8)'}
                  onChange={(e) => patch('station', 'timezone', e.target.value)}
                >
                  <option>Asia/Manila (UTC+8)</option>
                  <option>UTC</option>
                </select>
              </div>
              <h4>Recording &amp; storage</h4>
              <div className="switch-row">
                <div>
                  <div className="sw-label">Save detection snapshots</div>
                  <div className="sw-sub">Store a frame for every confirmed detection</div>
                </div>
                <Switch
                  checked={form.station?.saveSnapshots !== false}
                  onChange={(v) => patch('station', 'saveSnapshots', v)}
                />
              </div>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="cfg-retention">Retention period</label>
                  <select
                    id="cfg-retention"
                    value={form.station?.retention || '30 days'}
                    onChange={(e) => patch('station', 'retention', e.target.value)}
                  >
                    <option>30 days</option>
                    <option>14 days</option>
                    <option>90 days</option>
                    <option>Keep forever</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="cfg-clip">Clip length</label>
                  <select
                    id="cfg-clip"
                    value={form.station?.clipLength || '30 seconds'}
                    onChange={(e) => patch('station', 'clipLength', e.target.value)}
                  >
                    <option>30 seconds</option>
                    <option>60 seconds</option>
                    <option>2 minutes</option>
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="modal-foot">
        <button className="btn-ghost" type="button" onClick={closeSettings}>
          Cancel
        </button>
        <button className="btn-save" type="button" onClick={handleSave}>
          Save configuration
        </button>
      </div>
    </Modal>
  );
}
