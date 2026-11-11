import { useCallback, useRef } from 'react';
import StreamPlayer from './StreamPlayer';
import DetectionOverlay from './DetectionOverlay';
import { useCameraStore } from '../../stores/useCameraStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useStreamOverlay, useYoloOverlay } from '../../hooks/useYoloOverlay';
import { HUD_COORDS } from '../../data/mock';

const GO2RTC_BASE = import.meta.env.VITE_GO2RTC_URL || 'http://localhost:1990';

/** go2rtc stream name from a credential-free MSE/WebRTC URL (?src=cam03). */
function go2rtcSrcFromStreamUrl(url) {
  if (!url || /^rtsp:/i.test(url)) return null;
  try {
    const parsed = new URL(url, 'http://127.0.0.1');
    const src = parsed.searchParams.get('src');
    if (!src) return null;
    const path = parsed.pathname || '';
    const isGo2rtc =
      path.includes('/api/stream.') ||
      path.includes('/api/webrtc') ||
      path.includes('/webrtc.html') ||
      path.includes('/go2rtc/');
    return isGo2rtc ? src : null;
  } catch {
    return null;
  }
}

/** Known go2rtc names used when a camera has no stream URL yet. */
const KNOWN_GO2RTC = new Set(['cam01', 'cam02', 'cam03', 'cam04']);

/** Map a camera to its go2rtc stream. The stream URL wins over the camera id. */
function go2rtcSrcFor(camera) {
  const fromUrl = go2rtcSrcFromStreamUrl(camera?.stream_url);
  if (fromUrl) return fromUrl;
  if (camera?.go2rtc_src) return camera.go2rtc_src;
  const id = String(camera?.id || '').toUpperCase();
  const match = id.match(/CAM-?0*(\d+)/i);
  if (!match) return null;
  const src = `cam${String(match[1]).padStart(2, '0')}`;
  return KNOWN_GO2RTC.has(src) ? src : null;
}

function streamEmbedUrl(camera) {
  const src = go2rtcSrcFor(camera);
  if (!src) return null;
  return `${GO2RTC_BASE}/webrtc.html?src=${encodeURIComponent(src)}`;
}

/** Browser-playable MSE URL for the main <video> (via Vite /go2rtc proxy). */
function streamMseUrl(camera) {
  const src = go2rtcSrcFor(camera);
  if (!src) return null;
  return `/go2rtc/api/stream.mp4?src=${encodeURIComponent(src)}`;
}

function score01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n > 1.5 ? n / 100 : n;
}

function overlayBoxVisible(box, hudFloor) {
  const conf = score01(box.confidence);
  if (box.provisional === true) return conf >= 0.5;
  return conf >= Math.max(0.8, hudFloor);
}

function freshOverlayBoxes(boxes, meta, cameraId, minConf = 0.8) {
  const id = String(cameraId || '').toUpperCase();
  const floor = Math.max(0.8, Number(minConf) || 0.8);
  const panelBoxes = (boxes || []).filter((box) => {
    const boxCam = String(box.camera_id || meta?.cameraId || '').toUpperCase();
    if (boxCam && id && boxCam !== id) return false;
    return overlayBoxVisible(box, floor);
  });
  const detectPublishMs = meta?.detectToPublishMs ?? null;
  const overlayAgeMs =
    meta?.overlayAgeMs ??
    (meta?.overlayPublishedAt != null
      ? Math.max(0, Math.round((Date.now() / 1000 - meta.overlayPublishedAt) * 1000))
      : null);
  const staleMs = Math.max(25000, (detectPublishMs || 0) * 4 + 4000);
  if (overlayAgeMs != null && overlayAgeMs > staleMs) return [];
  return panelBoxes;
}

/** Grid tile with live go2rtc embed and this camera's own overlay. */
function CameraTile({ camera, active, onSelect, detectionOn, showBoxes, showConfidence }) {
  const embedUrl = streamEmbedUrl(camera);
  const offline = camera.status === 'offline';
  // A stale Offline flag must not hide a go2rtc stream that is actually up
  // (CAM-04 was live in go2rtc while the tile stayed empty).
  const showIframe = Boolean(embedUrl);
  const detectionAllowed = camera.detection !== false;
  const { boxes, meta } = useStreamOverlay({
    enabled: detectionOn && detectionAllowed && Boolean(camera.id),
    cameraId: camera.id,
  });
  const tileBoxes = freshOverlayBoxes(
    boxes,
    meta,
    camera.id,
    meta?.hudConf ?? 0.8,
  );
  const area = camera.location || camera.sector || '';

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
            scrolling="no"
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
        <div className="grid-tile-hud">
          <DetectionOverlay
            boxes={detectionAllowed ? tileBoxes : []}
            visible={detectionAllowed && detectionOn && showBoxes !== false}
            showConfidence={showConfidence !== false}
          />
        </div>
        {active && <span className="grid-tile-badge">Active</span>}
        {showIframe && <span className="grid-tile-live">LIVE</span>}
        <div className="grid-tile-status">
          {detectionOn && detectionAllowed && meta?.connected === false ? (
            <span>DETECT OFFLINE</span>
          ) : null}
          {detectionOn && detectionAllowed && meta?.motionActive ? (
            <span>MOTION</span>
          ) : null}
        </div>
      </div>
      <div className="grid-tile-label">
        {camera.name}
        {area ? <small> · {area}</small> : null}
      </div>
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
  const overlayMeta = useCameraStore((s) => s.overlayMeta);
  const gridView = useCameraStore((s) => s.gridView);
  const recording = useCameraStore((s) => s.recording);
  const setStreamStatus = useCameraStore((s) => s.setStreamStatus);
  const setLatencyMs = useCameraStore((s) => s.setLatencyMs);
  const setActiveCamera = useCameraStore((s) => s.setActiveCamera);
  const setGridView = useCameraStore((s) => s.setGridView);
  const settings = useSettingsStore((s) => s.settings);
  const openSettings = useSettingsStore((s) => s.openSettings);

  const conf = Math.max(
    0.8,
    Number(overlayMeta?.hudConf ?? settings.detection?.confidence ?? 0.8),
  );
  // Overlay follows the selected lens/camera when detection is enabled for it.
  const detectionAllowed = activeCamera?.detection !== false;
  const activeId = String(activeCameraId || '').toUpperCase();
  // Live video from go2rtc (low latency). Boxes from /overlay for this camera_id.
  const streamUrl = streamMseUrl(activeCamera) || '/stream.mjpeg';
  const streamProtocol = streamUrl?.includes('stream.mp4') ? 'MSE' : 'MJPEG';
  // Never paint another stream's boxes on this panel.
  const panelBoxes = (overlayBoxes || []).filter((box) => {
    const boxCam = String(box.camera_id || overlayMeta?.cameraId || '').toUpperCase();
    if (boxCam && activeId && boxCam !== activeId) return false;
    return overlayBoxVisible(box, conf);
  });
  const detectPublishMs =
    overlayMeta?.detectToPublishMs ?? inferenceMs ?? null;
  const inferFps = overlayMeta?.inferenceFps;
  const overlayAgeMs =
    overlayMeta?.overlayAgeMs ??
    (overlayMeta?.overlayPublishedAt != null
      ? Math.max(0, Math.round((Date.now() / 1000 - overlayMeta.overlayPublishedAt) * 1000))
      : null);
  // 4-stream CPU plus review I/O can leave overlay_age around 10–15s. Keep boxes.
  const staleMs = Math.max(25000, (detectPublishMs || 0) * 4 + 4000);
  const freshBoxes =
    overlayAgeMs != null && overlayAgeMs > staleMs ? [] : panelBoxes;

  useYoloOverlay({
    enabled: detectionOn && !gridView && detectionAllowed && Boolean(activeCameraId),
    cameraId: activeCameraId,
  });

  const onStatusChange = useCallback(
    (status) => setStreamStatus(status),
    [setStreamStatus],
  );

  const handleConnect = () => {
    openSettings();
    setStreamStatus('CONNECTING…');
  };

  const model =
    liveModel ||
    settings.detection?.model ||
    'YOLOv11n ONNX · best.onnx';

  return (
    <div
      className={`viewport${gridView ? ' grid-mode' : ''}`}
      id="viewport"
      ref={viewportRef}
    >
      {!gridView && (
        <div className="viewport-player">
          <StreamPlayer
            key={activeCameraId || 'cam'}
            url={streamUrl}
            protocol={streamProtocol}
            onStatusChange={onStatusChange}
            onLatency={setLatencyMs}
            cameraLabel={activeCamera?.id || 'CAM-01'}
            onConnectClick={handleConnect}
          />

          <div className="hud" aria-hidden="true">
            <div className="hud-top">
              <div className="hud-cam">
                {recording && <span className="rec">REC</span>}
                <span className="hud-cam-name">
                  {(activeCamera?.name || 'Wide-Angle Lens').toUpperCase()}
                </span>
                {activeCamera?.location || activeCamera?.sector ? (
                  <span className="hud-cam-name" style={{ opacity: 0.75 }}>
                    · {(activeCamera.location || activeCamera.sector || '').toUpperCase()}
                  </span>
                ) : null}
                {detectionOn && detectionAllowed && overlayMeta?.connected === false ? (
                  <span className="hud-cam-name" style={{ opacity: 0.85, color: '#f0a0a0' }}>
                    · DETECT OFFLINE
                  </span>
                ) : null}
                {detectionOn &&
                detectionAllowed &&
                overlayMeta?.motionActive ? (
                  <span className="hud-cam-name" style={{ opacity: 0.8 }}>
                    · MOTION
                  </span>
                ) : null}
              </div>
              <div className="hud-meta">
                <span>
                  {String(
                    activeCamera?.resolution || settings.stream?.resolution || '1920×1080',
                  ).replace(/\s/g, '')}
                </span>
                <span>{activeCamera?.fps || settings.stream?.fps || '25 FPS'}</span>
                <span>{latencyMs != null ? `${latencyMs} ms` : '— ms'}</span>
                {overlayMeta?.frameId != null ? (
                  <span style={{ opacity: 0.7 }}>f{overlayMeta.frameId}</span>
                ) : null}
              </div>
            </div>

            <DetectionOverlay
              boxes={detectionAllowed ? freshBoxes : []}
              visible={
                detectionAllowed &&
                detectionOn &&
                settings.detection?.showBoxes !== false
              }
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
                  {detectPublishMs != null && detectionAllowed
                    ? `${detectPublishMs} ms detect→HUD`
                    : '— ms detect→HUD'}
                </span>
                {inferFps != null && detectionAllowed ? (
                  <>
                    {' '}
                    · <span>{Number(inferFps).toFixed(1)} FPS</span>
                  </>
                ) : null}
              </div>
            </div>

            <span className="frame-tick tl" />
            <span className="frame-tick tr" />
            <span className="frame-tick bl" />
            <span className="frame-tick br" />
          </div>
        </div>
      )}

      {gridView && (
        <>
          <div className="viewport-player is-parked" aria-hidden="true" />
          <div className="camera-grid">
            {cameras.map((cam) => (
              <CameraTile
                key={cam.id}
                camera={cam}
                active={cam.id === activeCameraId}
                detectionOn={detectionOn}
                showBoxes={settings.detection?.showBoxes}
                showConfidence={settings.detection?.showConfidence}
                onSelect={(id) => {
                  setActiveCamera(id);
                  setGridView(false);
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
