import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  go2rtcSnapshotUrl,
  isBrowserPlayable,
  isHlsUrl,
  isMjpegUrl,
  isRtspUrl,
  resolvePlayableUrl,
} from '../../lib/streamUrl';

/**
 * Sidebar preview:
 * - Active camera: mirrors the main viewport (no second decoder)
 * - Other playable cameras: muted MSE/HLS/MJPEG
 * - RTSP / failed: reports offline via onStatus
 */
export default function CameraThumb({ url, protocol, active = false, onStatus, paused = false }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const refreshRef = useRef(null);
  const [mode, setMode] = useState('idle'); // idle | video | img | mirror | none
  const [imgSrc, setImgSrc] = useState(null);

  useEffect(() => {
    if (paused) return undefined;

    const video = videoRef.current;
    const cleanupHls = () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };

    cleanupHls();
    setImgSrc(null);
    setMode('idle');

    if (video) {
      video.onplaying = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    }

    if (!url || isRtspUrl(url, protocol) || !isBrowserPlayable(url, protocol)) {
      setMode('none');
      onStatus?.('offline');
      return cleanupHls;
    }

    const snapshotUrl = go2rtcSnapshotUrl(url);
    if (snapshotUrl) {
      setMode('img');
      const sep = snapshotUrl.includes('?') ? '&' : '?';
      setImgSrc(`${snapshotUrl}${sep}t=${Date.now()}`);
      return () => {
        clearTimeout(refreshRef.current);
        cleanupHls();
      };
    }

    const playUrl = resolvePlayableUrl(url);

    if (isMjpegUrl(playUrl)) {
      setMode('img');
      setImgSrc(playUrl);
      onStatus?.('live');
      return cleanupHls;
    }

    // HLS only when not go2rtc MSE
    if (isHlsUrl(playUrl) && !playUrl.includes('/api/stream.mp4')) {
      if (!video) {
        setMode('none');
        onStatus?.('offline');
        return cleanupHls;
      }
      setMode('video');
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, maxBufferLength: 3 });
        hlsRef.current = hls;
        hls.loadSource(playUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
          onStatus?.('live');
        });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            setMode('none');
            onStatus?.('offline');
          }
        });
      } else {
        setMode('none');
        onStatus?.('offline');
      }
      return cleanupHls;
    }

    // MSE / native video
    if (!video) {
      setMode('none');
      onStatus?.('offline');
      return cleanupHls;
    }
    setMode('video');
    video.src = playUrl;
    video.onplaying = () => onStatus?.('live');
    video.onerror = () => {
      setMode('none');
      onStatus?.('offline');
    };
    video.play().catch(() => {
      setMode('none');
      onStatus?.('offline');
    });

    return cleanupHls;
  }, [url, protocol, active, paused, onStatus]);

  if (mode === 'none' || paused) return null;

  return (
    <>
      <video
        ref={videoRef}
        className="cam-thumb-media"
        autoPlay
        muted
        playsInline
        style={{ display: mode === 'video' ? 'block' : 'none' }}
      />
      {mode === 'img' && imgSrc && (
        <img
          className="cam-thumb-media"
          src={imgSrc}
          alt=""
          draggable={false}
          onLoad={() => {
            onStatus?.('live');
            clearTimeout(refreshRef.current);
            refreshRef.current = setTimeout(() => {
              setImgSrc((current) => {
                if (!current) return current;
                const base = current.split('&t=')[0];
                return `${base}&t=${Date.now()}`;
              });
            }, 1200);
          }}
          onError={() => {
            onStatus?.('offline');
            clearTimeout(refreshRef.current);
            refreshRef.current = setTimeout(() => {
              setImgSrc((current) => {
                if (!current) return current;
                const base = current.split('&t=')[0];
                return `${base}&t=${Date.now()}`;
              });
            }, 2500);
          }}
        />
      )}
    </>
  );
}
