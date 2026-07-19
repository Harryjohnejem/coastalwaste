import { useCallback, useEffect, useRef } from 'react';
import StreamPlayer from './StreamPlayer';
import DetectionOverlay from './DetectionOverlay';
import { useCameraStore } from '../../stores/useCameraStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useYoloOverlay } from '../../hooks/useYoloOverlay';
import { isBrowserPlayable, isRtspUrl } from '../../lib/streamUrl';
import { HUD_COORDS } from '../../data/mock';

/** Grid tile: mirrors the kept-alive main player for the active cam. */
function CameraTile({ camera, active, onSelect }) {
  const canvasRef = useRef(null);
  const playable =
    !!camera.stream_url &&
    !isRtspUrl(camera.stream_url, camera.protocol) &&
    isBrowserPlayable(camera.stream_url, camera.protocol);

  useEffect(() => {
    if (!active || !playable) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const tick = () => {
      const video = document.querySelector('#viewport .viewport-player .stream-video');
      const img = document.querySelector('#viewport .viewport-player .stream-img');
      const source =
        video && video.style.display !== 'none' && video.readyState >= 2
          ? video
          : img && img.style.display !== 'none' && img.naturalWidth
            ? img
            : null;
      if (!source) return;
      const w = source.videoWidth || source.naturalWidth || 320;
      const h = source.videoHeight || source.naturalHeight || 180;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      try {
        canvas.getContext('2d').drawImage(source, 0, 0, w, h);
      } catch {
        /* tainted / not ready */
      }
    };

    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [active, playable]);

  return (
    <div
      className={`grid-tile${active ? ' active' : ''}`}
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
        {active && playable ? (
          <canvas ref={canvasRef} className="grid-tile-mirror" aria-hidden="true" />
        ) : (
          <div className="grid-tile-empty">
            <span>{camera.id}</span>
            <small>
              {!camera.stream_url
                ? 'No stream'
                : !playable
                  ? 'Needs HLS/MSE gateway'
                  : 'Select to view'}
            </small>
          </div>
        )}
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

  const url = activeCamera?.stream_url || settings.stream?.url || '';
  const protocol = activeCamera?.protocol || settings.stream?.protocol || '';
  const conf = settings.detection?.confidence ?? 0.55;

  useYoloOverlay({
    enabled: detectionOn && !gridView,
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
      {/* Keep one MSE decoder alive across grid toggle — unmounting kills the feed */}
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
