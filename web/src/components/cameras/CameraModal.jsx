import { useEffect, useState } from 'react';
import Modal from '../common/Modal';
import Switch from '../common/Switch';
import AppNotice from '../common/AppNotice';
import { useCameraStore } from '../../stores/useCameraStore';
import { confirmThenRun } from '../../stores/useNoticeStore';

const emptyForm = {
  name: '',
  sector: 'Sector A',
  stream_url: '',
  protocol: 'RTSP (via gateway)',
  transport: 'TCP',
  username: '',
  password: '',
  resolution: '1920 × 1080',
  fps: '25 FPS',
  detection: true,
  inGrid: true,
};

export default function CameraModal({ onConnectStream }) {
  const cameraModal = useCameraStore((s) => s.cameraModal);
  const cameras = useCameraStore((s) => s.cameras);
  const closeCameraModal = useCameraStore((s) => s.closeCameraModal);
  const createCamera = useCameraStore((s) => s.createCamera);
  const updateCamera = useCameraStore((s) => s.updateCamera);
  const removeCamera = useCameraStore((s) => s.removeCamera);
  const testCamera = useCameraStore((s) => s.testCamera);

  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const isEdit = cameraModal.mode === 'edit';
  const editing = cameras.find((c) => c.id === cameraModal.cameraId);

  useEffect(() => {
    if (!cameraModal.open) return;
    setError('');
    if (isEdit && editing) {
      // TODO: prefill protocol/credentials/etc. from your stored config
      setForm({
        name: editing.name || '',
        sector: editing.sector || 'Sector A',
        stream_url: editing.stream_url || '',
        protocol: editing.protocol || 'RTSP (via gateway)',
        transport: editing.transport || 'TCP',
        username: editing.username || '',
        password: '',
        resolution: editing.resolution || '1920 × 1080',
        fps: editing.fps || '25 FPS',
        detection: editing.detection !== false,
        inGrid: editing.inGrid !== false,
      });
    } else {
      setForm(emptyForm);
    }
  }, [cameraModal.open, cameraModal.cameraId, isEdit, editing]);

  const set = (key) => (e) => {
    const value = e?.target ? e.target.value : e;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const handleTest = async () => {
    setError('');
    setTesting(true);
    const outcome = await confirmThenRun({
      skipConfirm: true,
      busyTitle: 'Testing connection',
      busyMessage: 'Checking the camera URL and credentials.',
      busyLabel: 'Testing…',
      successTitle: 'Connection test',
      successMessage: isEdit ? 'Camera connection succeeded.' : 'Connection test started.',
      errorTitle: 'Connection failed',
      errorFallback: "Couldn't reach the camera. Check the URL and credentials.",
      work: async () => {
        if (isEdit && editing?.id) {
          const result = await testCamera(editing.id, form.stream_url);
          if (!result?.ok) {
            throw new Error("Couldn't reach the camera. Check the URL and credentials.");
          }
          onConnectStream?.(form.stream_url, form.protocol, result.latency_ms);
          return;
        }
        onConnectStream?.(form.stream_url, form.protocol);
      },
    });
    if (!outcome.ok && !outcome.cancelled) {
      setError(outcome.error?.message || "Couldn't reach the camera. Check the URL and credentials.");
    }
    setTesting(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    const payload = {
      name: form.name.trim() || 'New camera',
      sector: form.sector,
      stream_url: form.stream_url.trim(),
      protocol: form.protocol,
      transport: form.transport,
      username: form.username,
      resolution: form.resolution,
      fps: form.fps,
      detection: form.detection,
      inGrid: form.inGrid,
      status: 'offline',
    };
    const outcome = await confirmThenRun({
      title: isEdit ? 'Save camera changes?' : 'Add this camera?',
      message: isEdit
        ? `Update settings for ${form.name.trim() || 'this camera'}?`
        : `Add ${form.name.trim() || 'this camera'} to the station?`,
      confirmLabel: isEdit ? 'Save' : 'Add camera',
      busyTitle: isEdit ? 'Saving camera' : 'Adding camera',
      busyMessage: isEdit ? 'Updating camera settings.' : 'Adding this camera to the station.',
      busyLabel: 'Saving…',
      successTitle: isEdit ? 'Camera saved' : 'Camera added',
      successMessage: isEdit ? 'Camera settings saved.' : 'Camera added.',
      errorTitle: 'Camera not saved',
      work: async () => {
        if (isEdit && editing) {
          try {
            await updateCamera(editing.id, payload);
          } catch {
            useCameraStore.setState((s) => ({
              cameras: s.cameras.map((c) =>
                c.id === editing.id ? { ...c, ...payload } : c,
              ),
            }));
          }
          return;
        }
        const id = `CAM-${String(cameras.length + 1).padStart(2, '0')}`;
        try {
          await createCamera({ ...payload, id });
        } catch {
          useCameraStore.setState((s) => ({
            cameras: [...s.cameras, { ...payload, id, detections_per_hour: null }],
          }));
        }
      },
    });
    if (outcome.ok) closeCameraModal();
    if (outcome.error) setError(outcome.error.message || 'Could not save camera.');
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!editing) return;
    const outcome = await confirmThenRun({
      title: 'Remove this camera?',
      message: `"${editing.name}" will be removed from this station. Live monitoring for this lens will stop.`,
      confirmLabel: 'Remove camera',
      variant: 'danger',
      busyTitle: 'Removing camera',
      busyMessage: `Removing "${editing.name}" from this station.`,
      busyLabel: 'Removing…',
      successTitle: 'Camera removed',
      successMessage: `"${editing.name}" was removed from this station.`,
      errorTitle: 'Camera not removed',
      work: async () => {
        try {
          await removeCamera(editing.id);
        } catch {
          useCameraStore.setState((s) => {
            const next = s.cameras.filter((c) => c.id !== editing.id);
            return {
              cameras: next,
              activeCameraId:
                s.activeCameraId === editing.id ? next[0]?.id ?? null : s.activeCameraId,
            };
          });
        }
      },
    });
    if (outcome.ok) closeCameraModal();
    if (outcome.error) setError(outcome.error.message || 'Could not remove camera.');
  };

  return (
    <Modal
      open={cameraModal.open}
      onClose={closeCameraModal}
      labelledBy="camera-modal-title"
      size="sm"
    >
      <div className="modal-head">
        <h3 id="camera-modal-title">
          {isEdit ? (
            <>
              Camera <span>settings</span>
            </>
          ) : (
            <>
              Add <span>camera</span>
            </>
          )}
        </h3>
        <button className="modal-close" type="button" aria-label="Close camera settings" onClick={closeCameraModal}>
          ✕
        </button>
      </div>

      <div className="modal-body">
        <div className="tab-panes">
          <h4>Identity</h4>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="cam-cfg-name">Camera name</label>
              <input
                type="text"
                id="cam-cfg-name"
                placeholder="CAM-05 · Lagoon Point"
                value={form.name}
                onChange={set('name')}
              />
            </div>
            <div className="field">
              <label htmlFor="cam-cfg-zone">Monitoring sector</label>
              <select id="cam-cfg-zone" value={form.sector} onChange={set('sector')}>
                {['Sector A', 'Sector B', 'Sector C', 'Sector D', 'Sector E', 'Sector F'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          <h4>Stream source</h4>
          <div className="field">
            <label htmlFor="cam-cfg-url">Stream URL</label>
            <input
              type="text"
              id="cam-cfg-url"
              placeholder="rtsp://user:pass@192.168.1.68:554/stream1"
              value={form.stream_url}
              onChange={set('stream_url')}
            />
            <div className="hint">RTSP, HLS (.m3u8), MJPEG or HTTP snapshot endpoint</div>
          </div>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="cam-cfg-protocol">Protocol</label>
              <select id="cam-cfg-protocol" value={form.protocol} onChange={set('protocol')}>
                <option>RTSP (via gateway)</option>
                <option>HLS</option>
                <option>MJPEG</option>
                <option>WebRTC</option>
                <option>HTTP snapshot</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="cam-cfg-transport">Transport</label>
              <select id="cam-cfg-transport" value={form.transport} onChange={set('transport')}>
                <option>TCP</option>
                <option>UDP</option>
                <option>Auto</option>
              </select>
            </div>
          </div>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="cam-cfg-user">Username</label>
              <input type="text" id="cam-cfg-user" placeholder="admin" value={form.username} onChange={set('username')} />
            </div>
            <div className="field">
              <label htmlFor="cam-cfg-pass">Password</label>
              <input type="password" id="cam-cfg-pass" placeholder="••••••••" value={form.password} onChange={set('password')} />
            </div>
          </div>

          <h4>Video</h4>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="cam-cfg-res">Resolution</label>
              <select id="cam-cfg-res" value={form.resolution} onChange={set('resolution')}>
                <option>1920 × 1080</option>
                <option>1280 × 720</option>
                <option>2560 × 1440</option>
                <option>3840 × 2160</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="cam-cfg-fps">Frame rate</label>
              <select id="cam-cfg-fps" value={form.fps} onChange={set('fps')}>
                <option>25 FPS</option>
                <option>30 FPS</option>
                <option>15 FPS</option>
                <option>10 FPS</option>
              </select>
            </div>
          </div>

          <h4>Behaviour</h4>
          <div className="switch-row">
            <div>
              <div className="sw-label">Run waste detection</div>
              <div className="sw-sub">Include this feed in the CV pipeline</div>
            </div>
            <Switch checked={form.detection} onChange={(v) => setForm((f) => ({ ...f, detection: v }))} id="cam-cfg-detect" />
          </div>
          <div className="switch-row">
            <div>
              <div className="sw-label">Enable in grid view</div>
              <div className="sw-sub">Show this camera in the multi-feed layout</div>
            </div>
            <Switch checked={form.inGrid} onChange={(v) => setForm((f) => ({ ...f, inGrid: v }))} id="cam-cfg-grid" />
          </div>
          <div className="field" style={{ marginTop: 13 }}>
            <button className="test-btn" type="button" onClick={handleTest} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {error ? <AppNotice type="error" title="Camera error" message={error} /> : null}
          </div>
        </div>
      </div>

      <div className="modal-foot">
        {isEdit && (
          <button className="btn-danger foot-left" type="button" onClick={handleDelete} disabled={saving || testing}>
            Remove camera
          </button>
        )}
        <button className="btn-ghost" type="button" onClick={closeCameraModal}>
          Cancel
        </button>
        <button className="btn-save" type="button" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add camera'}
        </button>
      </div>
    </Modal>
  );
}
