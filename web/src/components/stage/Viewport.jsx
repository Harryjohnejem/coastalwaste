import { useCallback, useRef } from 'react';
import StreamPlayer from './StreamPlayer';
import DetectionOverlay from './DetectionOverlay';
import { useCameraStore } from '../../stores/useCameraStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useYoloOverlay } from '../../hooks/useYoloOverlay';
import { useAuthStore } from '../../stores/useAuthStore';
import { HUD_COORDS } from '../../data/mock';

const GO2RTC_BASE = import.meta.env.VITE_GO2RTC_URL || 'http://localhost:1990';

/** Map camera id → go2rtc stream name (cam01, cam02, …). */
function go2rtcSrcFor(camera) {
  const id = String(camera?.id || '').toUpperCase();
  const match = id.match(/CAM-?0*(\d+)/i);
  if (match) return `cam${String(match[1]).padStart(2, '0')}`;
  if (camera?.go2rtc_src) return camera.go2rtc_src;
  return null;
}

/** Known go2rtc stream names defined in gateway/go2rtc.yaml. */
const KNOWN_GO2RTC = new Set(['cam01']);

function streamEmbedUrl(camera) {
  const src = go2rtcSrcFor(camera);
  if (!src) return null;
  if (camera?.go2rtc_src) {
    return `${GO2RTC_BASE}/webrtc.html?src=${encodeURIComponent(camera.go2rtc_src)}`;
  }
  if (!KNOWN_GO2RTC.has(src)) return null;
  return `${GO2RTC_BASE}/webrtc.html?src=${encodeURIComponent(src)}`;
}

/** Browser-playable MSE URL for the main <video> (via Vite /go2rtc proxy). */
function streamMseUrl(camera) {
  const src = camera?.go2rtc_src || go2rtcSrcFor(camera);
  if (!src) return null;
  if (!camera?.go2rtc_src && !KNOWN_GO2RTC.has(src)) return null;
  return `/go2rtc/api/stream.mp4?src=${encodeURIComponent(src)}`;
}

/** Grid tile with live go2rtc embed (or empty/offline state). */
function CameraTile({ camera, active, onSelect }) {
  const embedUrl = streamEmbedUrl(camera);
  const offline = camera.status === 'offline';
  // Only force-show live iframe for streams we know exist, or any non-offline cam
  const showIframe = Boolean(embedUrl) && !offline;

  return (
    <div
      className={`grid-tile${active ? ' active' : ''}${offline ? ' offline' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(camera.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(camera.id);
        }
      }}
    >
      <div className="grid-tile-feed">
        {showIframe ? (
          <iframe
            className="grid-tile-iframe"
            src={embedUrl}
            title={`${camera.id} stream`}
            allow="autoplay; encrypted-media"
            loading="lazy"
          />
        ) : (
          <div className="grid-tile-empty">
            <span>{camera.id}</span>
            <small>
              {offline
                ? 'Offline'
                : !embedUrl
                  ? 'Add stream in go2rtc'
                  : 'Unavailable'}
            </small>
          </div>
        )}
        {active && <span className="grid-tile-badge">Active</span>}
        {showIframe && <span className="grid-tile-live">LIVE</span>}
      </div>
      <div className="grid-tile-label">{camera.name}</div>
    </div>
  );
}

export default function Viewport() {
  const viewportRef = useRef(null);
  const cameras = useCameraStore((s) => s.cameras);
  const activeCameraId = useCameraStore((s) => s.activeCameraId);
  const activeCamera = cameras.find((c) => c.id === activeCameraId) ?? null;
  const latencyMs = useCameraStore((s) => s.latencyMs);
  const inferenceMs = useCameraStore((s) => s.inferenceMs);
  const liveModel = useCameraStore((s) => s.liveModel);
  const detectionOn = useCameraStore((s) => s.detectionOn);
  const overlayBoxes = useCameraStore((s) => s.overlayBoxes);
  const gridView = useCameraStore((s) => s.gridView);
  const recording = useCameraStore((s) => s.recording);
  const setStreamStatus = useCameraStore((s) => s.setStreamStatus);
  const setLatencyMs = useCameraStore((s) => s.setLatencyMs);
  const setActiveCamera = useCameraStore((s) => s.setActiveCamera);
  const setGridView = useCameraStore((s) => s.setGridView);
  const settings = useSettingsStore((s) => s.settings);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const token = useAuthStore((s) => s.token);

  const mseUrl = streamMseUrl(activeCamera);
  const url = mseUrl || '/stream.mjpeg';
  const protocol = mseUrl ? 'MSE' : 'MJPEG';
  const conf = settings.detection?.confidence ?? 0.55;

  useYoloOverlay({
    enabled: Boolean(token) && detectionOn && !gridView,
    cameraId: activeCamera?.id || 'CAM-01',
  });

  const onStatusChange = useCallback(
    (status) => setStreamStatus(status),
    [setStreamStatus],
  );

  const handleConnect = () => {
    if (!url) {
      openSettings();
      return;
    }
    setStreamStatus('CONNECTING…');
  };

  const camName = (activeCamera?.name || 'CAM-01 · Pier Overlook').toUpperCase();
  const res = activeCamera?.resolution || settings.stream?.resolution || '1920×1080';
  const fps = activeCamera?.fps || settings.stream?.fps || '25 FPS';
  const model =
    liveModel ||
    settings.detection?.model?.replace(' (recommended)', '') ||
    'YOLO-World · waste';

  return (
    <div
      className={`viewport${gridView ? ' grid-mode' : ''}`}
      id="viewport"
      ref={viewportRef}
    >
      <div className={`viewport-player${gridView ? ' is-parked' : ''}`}>
        <StreamPlayer
          key={activeCameraId || 'cam'}
          url={url}
          protocol={protocol}
          onStatusChange={onStatusChange}
          onLatency={setLatencyMs}
          cameraLabel={activeCamera?.id || 'CAM-01'}
          onConnectClick={handleConnect}
        />

        {!gridView && (
          <div className="hud" aria-hidden="true">
            <div className="hud-top">
              <div className="hud-cam">
                {recording && <span className="rec">REC</span>}
                <span className="hud-cam-name">{camName}</span>
              </div>
              <div className="hud-meta">
                <span>{String(res).replace(/\s/g, '')}</span>
                <span>{fps}</span>
                <span>{latencyMs != null ? `${latencyMs} ms` : '— ms'}</span>
              </div>
            </div>

            <DetectionOverlay
              boxes={overlayBoxes}
              visible={detectionOn && settings.detection?.showBoxes !== false}
              showConfidence={settings.detection?.showConfidence !== false}
            />

            <div className="hud-bottom">
              <div className="hud-coords">
                LAT <b>{HUD_COORDS.lat}</b> · LON <b>{HUD_COORDS.lon}</b>
                <br />
                ZONE <b>{HUD_COORDS.zone}</b>
              </div>
              <div className="hud-model">
                <span className="model-chip">{model}</span>
                <br />
                CONF ≥ {Number(conf).toFixed(2)} · NMS 0.45 ·{' '}
                <span>
                  {inferenceMs != null ? `${inferenceMs} ms/frame` : '— ms/frame'}
                </span>
              </div>
            </div>

            <span className="frame-tick tl" />
            <span className="frame-tick tr" />
            <span className="frame-tick bl" />
            <span className="frame-tick br" />
          </div>
        )}
      </div>

      {gridView && (
        <div className="camera-grid">
          {cameras.map((cam) => (
            <CameraTile
              key={cam.id}
              camera={cam}
              active={cam.id === activeCameraId}
              onSelect={(id) => {
                setActiveCamera(id);
                setGridView(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
