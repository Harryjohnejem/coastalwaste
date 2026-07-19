import { useEffect, useRef } from 'react';
import Hls from 'hls.js';
import { RTSP_GATEWAY_MESSAGE } from '../../constants';
import { resolvePlayableUrl } from '../../lib/streamUrl';

function isMjpeg(url) {
  return /\.(jpg|jpeg|mjpg|mjpeg)|snapshot|mjpeg/i.test(url || '');
}

function isHls(url) {
  return /\.m3u8(\?|$)/i.test(url || '');
}

function isRtsp(url, protocol) {
  const p = (protocol || '').toUpperCase();
  return p.includes('RTSP') || /^rtsp:\/\//i.test(url || '');
}

/**
 * Plays camera streams:
 * - go2rtc → MSE MP4 (via Vite /go2rtc proxy when local)
 * - MJPEG / snapshot → <img>
 * - .m3u8 → hls.js
 * - otherwise → native <video src>
 * - RTSP → NoSignal with gateway message
 *
 * Note: do not set crossOrigin on MSE — it breaks go2rtc progressive MP4.
 * Same-origin /go2rtc proxy is enough for canvas detection.
 */
export default function StreamPlayer({
  url,
  protocol,
  onStatusChange,
  onLatency,
  noSignalMessage,
  cameraLabel,
  onConnectClick,
  mediaRef,
}) {
  const videoRef = useRef(null);
  const imgRef = useRef(null);
  const hlsRef = useRef(null);
  const statusRef = useRef(onStatusChange);
  statusRef.current = onStatusChange;

  const rtspBlocked = isRtsp(url, protocol);
  const showNoSignal = !url || rtspBlocked;

  useEffect(() => {
    const video = videoRef.current;
    const img = imgRef.current;
    let aborted = false;
    const report = (s) => {
      if (!aborted) statusRef.current?.(s);
    };

    const setMedia = (el) => {
      if (mediaRef) mediaRef.current = el;
    };

    const cleanupHls = () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };

    const resetMedia = () => {
      cleanupHls();
      if (video) {
        video.onplaying = null;
        video.onerror = null;
        video.pause?.();
        video.removeAttribute('src');
        video.load();
        video.style.display = 'none';
      }
      if (img) {
        img.onload = null;
        img.onerror = null;
        img.removeAttribute('src');
        img.style.display = 'none';
      }
      setMedia(null);
    };

    resetMedia();

    if (!url || rtspBlocked) {
      report('STANDBY');
      return () => {
        aborted = true;
        resetMedia();
      };
    }

    const playUrl = resolvePlayableUrl(url) || url;
    report('CONNECTING…');

    if (isMjpeg(playUrl) && img) {
      img.src = playUrl;
      img.onload = () => {
        if (aborted) return;
        img.style.display = 'block';
        setMedia(img);
        report('LIVE');
      };
      img.onerror = () => report('ERROR');
      return () => {
        aborted = true;
        resetMedia();
      };
    }

    if (!video) {
      report('ERROR');
      return () => {
        aborted = true;
      };
    }

    // go2rtc MSE progressive MP4
    if (/\/api\/stream\.mp4/i.test(playUrl)) {
      video.style.display = 'block';
      video.src = playUrl;
      setMedia(video);
      video.onplaying = () => report('LIVE');
      video.onerror = () => {
        if (aborted) return;
        // Fall back to original URL via HLS if present
        if (isHls(url)) {
          playHls(url, video, report, hlsRef, () => aborted, setMedia);
        } else {
          report('ERROR');
        }
      };
      video.play().catch(() => {});
      return () => {
        aborted = true;
        resetMedia();
      };
    }

    if (isHls(playUrl)) {
      playHls(playUrl, video, report, hlsRef, () => aborted, setMedia);
      return () => {
        aborted = true;
        resetMedia();
      };
    }

    video.style.display = 'block';
    video.src = playUrl;
    setMedia(video);
    video.onplaying = () => report('LIVE');
    video.onerror = () => {
      if (aborted) return;
      video.style.display = 'none';
      report('ERROR');
    };
    video.play().catch(() => {});

    return () => {
      aborted = true;
      resetMedia();
    };
    // Only reconnect when the source changes — not on every parent re-render
  }, [url, protocol, rtspBlocked, mediaRef]);

  const message = rtspBlocked
    ? RTSP_GATEWAY_MESSAGE
    : noSignalMessage ||
      `${cameraLabel || 'Camera'} · configure the stream source to begin monitoring`;

  return (
    <>
      <video
        ref={videoRef}
        className="stream-video"
        autoPlay
        muted
        playsInline
      />
      <img ref={imgRef} className="stream-img" alt="Live camera stream" />

      {showNoSignal && (
        <div className="no-signal">
          <div className="sonar" aria-hidden="true">
            <div className="sweep" />
          </div>
          <h2>Awaiting camera signal</h2>
          <p>{message}</p>
          {!rtspBlocked && (
            <button className="connect-cta" type="button" onClick={onConnectClick}>
              Connect stream
            </button>
          )}
        </div>
      )}
    </>
  );
}

function playHls(url, video, report, hlsRef, isAborted, setMedia) {
  video.style.display = 'block';
  setMedia?.(video);
  if (Hls.isSupported()) {
    const hls = new Hls();
    hlsRef.current = hls;
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (isAborted()) return;
      video.play().catch(() => {});
      report('LIVE');
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!isAborted() && data.fatal) report('ERROR');
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.onplaying = () => {
      if (!isAborted()) report('LIVE');
    };
    video.onerror = () => {
      if (!isAborted()) report('ERROR');
    };
    video.play().catch(() => {});
  } else {
    report('ERROR');
  }
}
