import { useEffect, useRef, useState } from 'react';
import Modal from '../common/Modal';
import Switch from '../common/Switch';
import AppNotice from '../common/AppNotice';
import { useCameraStore } from '../../stores/useCameraStore';
import { probeCamera } from '../../api/cameras';
import { confirmThenRun } from '../../stores/useNoticeStore';

const emptyForm = {
  mode: 'ip',
  name: '',
  sector: 'Paco Beach',
  ip_address: '',
  rtsp_port: '554',
  rtsp_path: '/stream1',
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

  // Fill the form once per opening. The camera list refreshes while video plays;
  // re-filling on every refresh would undo what the user picks or types.
  const filledFor = useRef(null);
  useEffect(() => {
    if (!cameraModal.open) {
      filledFor.current = null;
      return;
    }
    const key = `${cameraModal.mode}:${cameraModal.cameraId || ''}`;
    if (filledFor.current === key) return;
    if (isEdit && !editing) return;
    filledFor.current = key;
    setError('');
    if (isEdit && editing) {
      // TODO: prefill protocol/credentials/etc. from your stored config
      setForm({
        // IP cameras added here open by IP; CAM-01/CAM-02 keep their stream URL.
        mode: editing.managed || !editing.stream_url ? 'ip' : 'url',
        name: editing.name || '',
        sector: editing.sector || editing.location || 'Paco Beach',
        ip_address: editing.managed ? editing.ip_address || '' : '',
        rtsp_port: String(editing.rtsp_port || 554),
        rtsp_path: editing.rtsp_path || '/stream1',
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
  }, [cameraModal.open, cameraModal.mode, cameraModal.cameraId, isEdit, editing]);

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
      successMessage: form.mode === 'ip'
        ? 'The camera answered with a live picture. You can save it now.'
        : isEdit ? 'Camera connection succeeded.' : 'Connection test started.',
      errorTitle: 'Connection failed',
      errorFallback: "Couldn't reach the camera. Check the URL and credentials.",
      work: async () => {
        if (form.mode === 'ip') {
          if (!form.ip_address.trim()) throw new Error('Enter the camera IP address first.');
          const result = await probeCamera({
            ip_address: form.ip_address.trim(),
            rtsp_port: Number(form.rtsp_port) || 554,
            rtsp_path: form.rtsp_path.trim() || '/stream1',
            username: form.username.trim(),
            password: form.password,
            transport: form.transport,
            camera: isEdit ? editing?.id : undefined,
          });
          if (!result?.ok) {
            throw new Error(result?.message || 'No picture from the camera. Check the IP address, port, path, username and password.');
          }
          return;
        }
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
    if (form.mode === 'ip' && !form.ip_address.trim()) {
      setError('Enter the camera IP address.');
      setSaving(false);
      return;
    }
    const payload = {
      name: form.name.trim() || 'New camera',
      sector: form.sector.trim() || 'Paco Beach',
      transport: form.transport,
      username: form.username.trim(),
      resolution: form.resolution,
      fps: form.fps,
      detection: form.detection,
      inGrid: form.inGrid,
    };
    if (!isEdit) payload.status = 'offline';
    if (form.mode === 'ip') {
      // The server makes the gateway stream and the playback URL.
      payload.ip_address = form.ip_address.trim();
      payload.rtsp_port = Number(form.rtsp_port) || 554;
      payload.rtsp_path = form.rtsp_path.trim() || '/stream1';
      if (!editing?.managed) payload.stream_url = '';
    } else {
      payload.stream_url = form.stream_url.trim();
      payload.protocol = form.protocol;
      if (editing?.managed) payload.ip_address = null;
    }
    if (form.password) payload.password = form.password;
    const outcome = await confirmThenRun({
      title: isEdit ? 'Save camera changes?' : 'Add this camera?',
      message: isEdit
        ? `Update settings for ${form.name.trim() || 'this camera'}? Changes are stored in the station database.`
        : `Add ${form.name.trim() || 'this camera'} to the station database? It will stay after refresh.`,
      confirmLabel: isEdit ? 'Save' : 'Add camera',
      busyTitle: isEdit ? 'Saving camera' : 'Adding camera',
      busyMessage: isEdit ? 'Updating camera settings.' : 'Saving this camera to the station database.',
      busyLabel: 'Saving…',
      successTitle: isEdit ? 'Camera saved' : 'Camera added',
      successMessage: isEdit ? 'Camera settings saved.' : 'Camera added and will stay after refresh.',
      errorTitle: 'Camera not saved',
      work: async () => {
        if (isEdit && editing) {
          await updateCamera(editing.id, payload);
          return;
        }
        await createCamera(payload);
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
        await removeCamera(editing.id);
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
                placeholder="Paco Beach wide lens"
                value={form.name}
                onChange={set('name')}
              />
            </div>
            <div className="field">
              <label htmlFor="cam-cfg-zone">Monitoring location</label>
              <input
                type="text"
                id="cam-cfg-zone"
                placeholder="Paco Beach"
                value={form.sector}
                onChange={set('sector')}
              />
            </div>
          </div>

          <h4>Stream source</h4>
          <div className="cam-mode" role="radiogroup" aria-label="How to connect">
            <button
              type="button"
              role="radio"
              aria-checked={form.mode === 'ip'}
              className={form.mode === 'ip' ? 'is-on' : ''}
              onClick={() => setForm((f) => ({ ...f, mode: 'ip' }))}
            >
              IP camera
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={form.mode === 'url'}
              className={form.mode === 'url' ? 'is-on' : ''}
              onClick={() => setForm((f) => ({ ...f, mode: 'url' }))}
            >
              Stream URL
            </button>
          </div>
          {form.mode === 'ip' ? (
            <>
              {isEdit && editing && !editing.managed && editing.stream_url ? (
                <AppNotice
                  type="warning"
                  title="This camera is set up in the gateway file"
                  message={`${editing.id} already streams from gateway/go2rtc.yaml. Saving it as an IP camera opens the camera a second time, and Tapo cameras can drop the picture. Keep "Stream URL" unless you are moving this camera off the gateway file.`}
                />
              ) : null}
              <div className="hint" style={{ marginBottom: 10 }}>
                Type the camera&apos;s address and its camera account. The video gateway and the
                detector pick it up on their own — no config files to edit.
              </div>
              <div className="field-grid cam-ip-grid">
                <div className="field">
                  <label htmlFor="cam-cfg-ip">IP address</label>
                  <input
                    type="text"
                    id="cam-cfg-ip"
                    inputMode="decimal"
                    placeholder="192.168.1.68"
                    autoComplete="off"
                    value={form.ip_address}
                    onChange={set('ip_address')}
                  />
                </div>
                <div className="field">
                  <label htmlFor="cam-cfg-port">RTSP port</label>
                  <input
                    type="number"
                    id="cam-cfg-port"
                    min="1"
                    max="65535"
                    value={form.rtsp_port}
                    onChange={set('rtsp_port')}
                  />
                </div>
              </div>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="cam-cfg-path">Stream path</label>
                  <input
                    type="text"
                    id="cam-cfg-path"
                    placeholder="/stream1"
                    autoComplete="off"
                    value={form.rtsp_path}
                    onChange={set('rtsp_path')}
                  />
                  <div className="hint">Tapo: /stream1 (high quality) or /stream2 (low).</div>
                </div>
                <div className="field">
                  <label htmlFor="cam-cfg-transport-ip">Transport</label>
                  <select id="cam-cfg-transport-ip" value={form.transport} onChange={set('transport')}>
                    <option>TCP</option>
                    <option>UDP</option>
                  </select>
                </div>
              </div>
            </>
          ) : (
          <>
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
          </>
          )}
          <div className="field-grid">
            <div className="field">
              <label htmlFor="cam-cfg-user">Username</label>
              <input
                type="text"
                id="cam-cfg-user"
                name="camera-account-user"
                placeholder="Camera account (not your email)"
                autoComplete="off"
                value={form.username}
                onChange={set('username')}
              />
            </div>
            <div className="field">
              <label htmlFor="cam-cfg-pass">Password</label>
              <input
                type="password"
                id="cam-cfg-pass"
                name="camera-account-pass"
                placeholder={editing?.has_password ? 'Saved — leave blank to keep' : '••••••••'}
                autoComplete="new-password"
                value={form.password}
                onChange={set('password')}
              />
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
