import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
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
  const canvasRef = useRef(null);
  const hlsRef = useRef(null);
  const [mode, setMode] = useState('idle'); // idle | video | img | mirror | none
  const [imgSrc, setImgSrc] = useState(null);

  // Mirror active feed from main viewport — avoids dual decode freeze
  useEffect(() => {
    if (!active || paused) return undefined;
    setMode('mirror');
    onStatus?.('live');

    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const tick = () => {
      const video = document.querySelector(
        '#viewport .viewport-player .stream-video, #viewport .stream-video',
      );
      const img = document.querySelector(
        '#viewport .viewport-player .stream-img, #viewport .stream-img',
      );
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
        /* ignore */
      }
    };

    tick();
    const id = setInterval(tick, 400);
    return () => clearInterval(id);
  }, [active, paused, onStatus]);

  useEffect(() => {
    if (active || paused) return undefined;

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
      {mode === 'mirror' && (
        <canvas ref={canvasRef} className="cam-thumb-media" aria-hidden="true" />
      )}
      <video
        ref={videoRef}
        className="cam-thumb-media"
        autoPlay
        muted
        playsInline
        style={{ display: mode === 'video' ? 'block' : 'none' }}
      />
      {mode === 'img' && imgSrc && (
        <img className="cam-thumb-media" src={imgSrc} alt="" draggable={false} />
      )}
    </>
  );
}
