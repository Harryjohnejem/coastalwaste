import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { RTSP_GATEWAY_MESSAGE } from '../../constants';
import { resolvePlayableUrl } from '../../lib/streamUrl';
import { catchUpLive, go2rtcSrcFromUrl, playGo2rtcWebRtc } from '../../lib/go2rtcLive';

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
 * Plays camera streams into a real <video>/<img> so Record can use captureStream.
 * - go2rtc → MSE MP4 (via Vite /go2rtc proxy when local)
 * - MJPEG → <img>
 * - .m3u8 → hls.js
 * - RTSP without gateway URL → standby
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

  const [failed, setFailed] = useState(false);
  const rtspBlocked = isRtsp(url, protocol);
  const showNoSignal = !url || rtspBlocked || failed;

  useEffect(() => {
    const video = videoRef.current;
    const img = imgRef.current;
    let aborted = false;
    const report = (s) => {
      if (aborted) return;
      if (s === 'LIVE') setFailed(false);
      if (s === 'ERROR') setFailed(true);
      statusRef.current?.(s);
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
        video.srcObject = null;
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
    const t0 = performance.now();
    let snapshotTimer;
    let watchdog;

    const snapshotForCamera = (path) => {
      if (!cameraLabel) return path;
      const sep = path.includes('?') ? '&' : '?';
      return `${path}${sep}camera_id=${encodeURIComponent(cameraLabel)}`;
    };

    const startSnapshot = (snapUrl) => {
      if (!img) {
        report('ERROR');
        return;
      }
      clearInterval(snapshotTimer);
      const tick = () => {
        const sep = snapUrl.includes('?') ? '&' : '?';
        img.src = `${snapUrl}${sep}t=${Date.now()}`;
      };
      img.onload = () => {
        if (aborted) return;
        img.style.display = 'block';
        if (video) video.style.display = 'none';
        setMedia(img);
        onLatency?.(Math.round(performance.now() - t0));
        report('LIVE');
      };
      img.onerror = () => {
        if (aborted) return;
        // An unscoped preview may still try MJPEG. A named camera that has no
        // frame must not fall through to another camera's picture.
        if (snapUrl.startsWith('/frame.jpeg') && !snapUrl.includes('camera_id=')) {
          startSnapshot('/stream.mjpeg');
          return;
        }
        report('ERROR');
      };
      if (/mjpeg/i.test(snapUrl)) {
        img.src = snapUrl;
        return;
      }
      tick();
      snapshotTimer = setInterval(tick, 700);
    };

    if (isMjpeg(playUrl) && img) {
      img.style.display = 'block';
      img.src = playUrl;
      img.onload = () => {
        if (aborted) return;
        setMedia(img);
        onLatency?.(Math.round(performance.now() - t0));
        report('LIVE');
      };
      img.onerror = () => {
        if (aborted) return;
        // Keep trying — first frames can 503 while the preview thread starts.
        setTimeout(() => {
          if (aborted || !img) return;
          const sep = playUrl.includes('?') ? '&' : '?';
          img.src = `${playUrl}${sep}_=${Date.now()}`;
        }, 400);
      };
      return () => {
        aborted = true;
        clearInterval(snapshotTimer);
        resetMedia();
      };
    }

    if (!video) {
      report('ERROR');
      return () => {
        aborted = true;
      };
    }

    // go2rtc: WebRTC first (low delay), then MSE with live-edge catch-up
    const go2src = go2rtcSrcFromUrl(playUrl);
    if (go2src && /\/api\/stream\.mp4/i.test(playUrl)) {
      let pc = null;
      let catchUpTimer;
      let usedMse = false;
      video.style.display = 'block';
      setMedia(video);
      video.preload = 'none';

      const markLive = () => {
        clearTimeout(watchdog);
        onLatency?.(Math.round(performance.now() - t0));
        report('LIVE');
      };

      const startMse = () => {
        if (aborted || !video || usedMse) return;
        usedMse = true;
        try {
          pc?.close();
        } catch {
          /* ignore */
        }
        pc = null;
        video.srcObject = null;
        video.src = playUrl;
        video.onplaying = () => {
          markLive();
          catchUpLive(video, 0.25);
        };
        video.onerror = () => {
          if (aborted) return;
          video.style.display = 'none';
          startSnapshot(snapshotForCamera('/frame.jpeg'));
        };
        catchUpTimer = setInterval(() => catchUpLive(video, 0.25), 400);
        video.play().catch(() => {
          if (!aborted) startSnapshot(snapshotForCamera('/frame.jpeg'));
        });
      };

      playGo2rtcWebRtc(video, go2src, { timeoutMs: 3500 })
        .then((conn) => {
          if (aborted) {
            conn.close();
            return;
          }
          pc = conn;
          markLive();
        })
        .catch(() => {
          if (!aborted) startMse();
        });

      watchdog = setTimeout(() => {
        if (aborted) return;
        const playing =
          (video.srcObject && video.readyState >= 2) ||
          (video.currentTime > 0 && !video.paused && video.readyState >= 2);
        if (!playing) startMse();
      }, 7000);

      return () => {
        aborted = true;
        clearTimeout(watchdog);
        clearInterval(snapshotTimer);
        clearInterval(catchUpTimer);
        try {
          pc?.close();
        } catch {
          /* ignore */
        }
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
    video.onplaying = () => {
      onLatency?.(Math.round(performance.now() - t0));
      report('LIVE');
    };
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
  }, [url, protocol, rtspBlocked, mediaRef, onLatency, cameraLabel]);

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
        preload="none"
      />
      <img ref={imgRef} className="stream-img" alt="Live camera stream" />

      {showNoSignal && (
        <div className="no-signal">
          <div className="sonar" aria-hidden="true">
            <div className="sweep" />
          </div>
          <h2>Awaiting camera signal</h2>
          <p>
            {rtspBlocked
              ? message
              : failed
                ? `${cameraLabel || 'Camera'} is not connected. The live stream is unavailable — check that go2rtc is running and this camera’s RTSP account is enabled.`
                : message}
          </p>
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
