import { useCallback, useEffect } from 'react';
import { useCameraStore } from '../../stores/useCameraStore';
import CameraThumb from './CameraThumb';
import { isBrowserPlayable, isRtspUrl } from '../../lib/streamUrl';

export default function CameraCard({ camera, active, onSelect, onEdit }) {
  const streamStatus = useCameraStore((s) => s.streamStatus);
  const gridView = useCameraStore((s) => s.gridView);
  const setCameraStatus = useCameraStore((s) => s.setCameraStatus);

  const playable = isBrowserPlayable(camera.stream_url, camera.protocol);
  const rtsp = isRtspUrl(camera.stream_url, camera.protocol);

  const online =
    (active && streamStatus === 'LIVE') ||
    camera.status === 'live' ||
    camera.status === 'LIVE' ||
    camera.status === 'online';

  const onThumbStatus = useCallback(
    (status) => {
      if (status === 'live') setCameraStatus(camera.id, 'live');
      if (status === 'offline') setCameraStatus(camera.id, 'offline');
    },
    [camera.id, setCameraStatus],
  );

  useEffect(() => {
    if (rtsp || !camera.stream_url) {
      setCameraStatus(camera.id, 'offline');
    }
  }, [rtsp, camera.stream_url, camera.id, setCameraStatus]);

  const showFeed = playable && !rtsp;

  return (
    <article
      className={`cam-card${active ? ' active' : ''}`}
      tabIndex={0}
      onClick={() => onSelect?.(camera.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.(camera.id);
        }
      }}
    >
      <div className={`cam-thumb${showFeed ? ' has-feed' : ''}`}>
        <span className={`live-tag ${online ? 'on' : 'off'}`}>
          {online ? 'LIVE' : 'OFFLINE'}
        </span>

        {showFeed ? (
          <CameraThumb
            url={camera.stream_url}
            protocol={camera.protocol}
            active={active}
            paused={gridView}
            onStatus={onThumbStatus}
          />
        ) : null}

        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M23 7l-7 5 7 5V7z" />
          <rect x="1" y="5" width="15" height="14" rx="2" />
          {!online && <path d="M2 2l20 20" strokeWidth="2" />}
        </svg>

        {camera.detections_per_hour != null && online && (
          <span className="det-tag">{camera.detections_per_hour} det/hr</span>
        )}
      </div>
      <div className="cam-meta">
        <div>
          <div className="cam-name">{camera.name}</div>
          <div className="cam-loc">{camera.stream_url || '—'}</div>
        </div>
        <button
          className="cam-edit"
          type="button"
          title="Camera settings"
          aria-label="Camera settings"
          onClick={(e) => {
            e.stopPropagation();
            onEdit?.(camera.id);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3h.1a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5h.1a1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8v.1a1.6 1.6 0 001.5 1h.1a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" />
          </svg>
        </button>
      </div>
    </article>
  );
}
