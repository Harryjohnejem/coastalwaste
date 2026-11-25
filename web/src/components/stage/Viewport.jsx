import { useCallback, useEffect, useRef, useState } from 'react';
import StreamPlayer from './StreamPlayer';
import DetectionOverlay from './DetectionOverlay';
import { useCameraStore } from '../../stores/useCameraStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useStreamOverlay, useYoloOverlay } from '../../hooks/useYoloOverlay';
import { camerasInGrid } from '../../lib/gridCameras';

/** go2rtc stream name from a credential-free MSE/WebRTC URL (?src=cam02). */
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
  // A tracked object stays drawn while the detector still has it.
  if (box.track_id != null || box.held === true) return true;
  const score = score01(box.confidence);
  if (box.provisional === true) return score >= 0.5;
  return score >= Math.max(0.8, hudFloor);
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
function CameraTile({ camera, active, onSelect, onOpen, detectionOn, showBoxes, showConfidence }) {
  const mseUrl = streamMseUrl(camera);
  const [tileLive, setTileLive] = useState(false);
  const [tileAttempt, setTileAttempt] = useState(0);
  const setCameraOverlay = useCameraStore((s) => s.setCameraOverlay);
  const clearCameraOverlay = useCameraStore((s) => s.clearCameraOverlay);
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

  useEffect(() => {
    if (!camera.id || !detectionOn || !detectionAllowed) {
      if (camera.id) clearCameraOverlay(camera.id);
      return undefined;
    }
    setCameraOverlay(camera.id, { boxes, meta });
    return () => clearCameraOverlay(camera.id);
  }, [camera.id, detectionOn, detectionAllowed, boxes, meta, setCameraOverlay, clearCameraOverlay]);

  return (
    <div
      className={`grid-tile${active ? ' active' : ''}${tileLive ? '' : ' offline'}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(camera.id)}
      onDoubleClick={() => onOpen?.(camera.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(camera.id);
        }
      }}
    >
      <div
        className="grid-tile-feed"
        onClick={(event) => {
          if (event.target.closest('button')) event.stopPropagation();
        }}
      >
        {mseUrl ? (
          <StreamPlayer
            key={`${camera.id}-${tileAttempt}`}
            url={mseUrl}
            protocol="MSE"
            cameraLabel={camera.id}
            onStatusChange={(status) => setTileLive(status === 'LIVE')}
            onConnectClick={() => setTileAttempt((n) => n + 1)}
          />
        ) : (
          <div className="grid-tile-empty">
            <span>{camera.id}</span>
            <small>Add stream in go2rtc</small>
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
        {tileLive && <span className="grid-tile-live">LIVE</span>}
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

function LensPane({
  camera,
  role,
  active,
  detectionOn,
  showBoxes,
  showConfidence,
  playerAttempt,
  onSelect,
  onStatusChange,
  onLatency,
  onConnectClick,
}) {
  const { boxes, meta } = useStreamOverlay({
    enabled: Boolean(camera?.id) && detectionOn && camera?.detection !== false,
    cameraId: camera?.id,
  });
  const floor = Math.max(0.8, Number(meta?.hudConf) || 0.8);
  const fresh = freshOverlayBoxes(boxes, meta, camera?.id, floor);
  const url = streamMseUrl(camera) || '/stream.mjpeg';
  const protocol = url.includes('stream.mp4') ? 'MSE' : 'MJPEG';
  const allowed = camera?.detection !== false;

  return (
    <div
      className={`lens-pane${active ? ' active' : ''}`}
      onClick={() => camera?.id && onSelect(camera.id)}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && camera?.id) {
          event.preventDefault();
          onSelect(camera.id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="viewport-player">
        <StreamPlayer
          key={`${camera?.id || role}-${playerAttempt}`}
          url={url}
          protocol={protocol}
          onStatusChange={active ? onStatusChange : undefined}
          onLatency={active ? onLatency : undefined}
          cameraLabel={camera?.id || role}
          onConnectClick={active ? onConnectClick : undefined}
        />
        <div className="hud" aria-hidden="true">
          <div className="hud-top">
            <div className="hud-cam">
              <span className="hud-cam-name">
                {camera?.name || camera?.id || role}
              </span>
            </div>
          </div>
          <DetectionOverlay
            boxes={allowed ? fresh : []}
            visible={allowed && detectionOn && showBoxes !== false}
            showConfidence={showConfidence !== false}
          />
        </div>
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
  const overlayMeta = useCameraStore((s) => s.overlayMeta);
  const gridView = useCameraStore((s) => s.gridView);
  const recording = useCameraStore((s) => s.recording);
  const streamStatus = useCameraStore((s) => s.streamStatus);
  const setStreamStatus = useCameraStore((s) => s.setStreamStatus);
  const setLatencyMs = useCameraStore((s) => s.setLatencyMs);
  const [playerAttempt, setPlayerAttempt] = useState(0);
  const setActiveCamera = useCameraStore((s) => s.setActiveCamera);
  const setGridView = useCameraStore((s) => s.setGridView);
  const settings = useSettingsStore((s) => s.settings);

  useEffect(() => {
    if (streamStatus !== 'ERROR') return undefined;
    const timer = setTimeout(() => {
      setLatencyMs(null);
      setPlayerAttempt((attempt) => attempt + 1);
    }, 4000);
    return () => clearTimeout(timer);
  }, [streamStatus, playerAttempt, setLatencyMs]);

  const detectionAllowed = activeCamera?.detection !== false;
  const detectPublishMs = overlayMeta?.detectToPublishMs ?? inferenceMs ?? null;

  useYoloOverlay({
    enabled: detectionOn && !gridView && detectionAllowed && Boolean(activeCameraId),
    cameraId: activeCameraId,
  });

  const onStatusChange = useCallback(
    (status) => setStreamStatus(status),
    [setStreamStatus],
  );

  const handleConnect = () => {
    setLatencyMs(null);
    setStreamStatus('CONNECTING…');
    setPlayerAttempt((attempt) => attempt + 1);
  };

  // Same name as Dataset Source and Today's Report, e.g. "YOLOv11l / Roboflow · local-ortk7 v2".
  const model =
    settings.live_model?.label ||
    settings.detection?.model ||
    liveModel ||
    'YOLOv11l / Roboflow';

  return (
    <div
      className={`viewport${gridView ? ' grid-mode' : ''}${detectionOn ? '' : ' detection-off'}`}
      id="viewport"
      ref={viewportRef}
    >
      {!gridView && activeCamera && (
        <div className="camera-stage">
          <LensPane
            camera={activeCamera}
            role={activeCamera.id}
            active
            detectionOn={detectionOn}
            showBoxes={settings.detection?.showBoxes}
            showConfidence={settings.detection?.showConfidence}
            playerAttempt={playerAttempt}
            onSelect={setActiveCamera}
            onStatusChange={onStatusChange}
            onLatency={setLatencyMs}
            onConnectClick={handleConnect}
          />
          <div className="camera-stage-meta">
            {recording ? <span className="rec">REC</span> : null}
            <span>{activeCamera.name || activeCamera.id}</span>
            <span className="model-chip">{model}</span>
            <span>{latencyMs != null ? `${latencyMs} ms` : '— ms'}</span>
            {detectPublishMs != null ? <span>{detectPublishMs} ms detect</span> : null}
          </div>
        </div>
      )}

      {gridView && (
        <>
          <div className="viewport-player is-parked" aria-hidden="true" />
          <div className="camera-grid">
            {camerasInGrid(cameras).length === 0 ? (
              <div className="grid-tile-empty">
                <span>No cameras in grid</span>
                <small>Turn on Enable in grid view for the wide cameras</small>
              </div>
            ) : null}
            {camerasInGrid(cameras).map((cam) => (
              <CameraTile
                key={cam.id}
                camera={cam}
                active={cam.id === activeCameraId}
                detectionOn={detectionOn}
                showBoxes={settings.detection?.showBoxes}
                showConfidence={settings.detection?.showConfidence}
                onSelect={setActiveCamera}
                onOpen={(id) => {
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
