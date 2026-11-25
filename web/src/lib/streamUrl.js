export function isRtspUrl(url, protocol) {
  const p = (protocol || '').toUpperCase();
  return p.includes('RTSP') || /^rtsp:\/\//i.test(url || '');
}

export function isMjpegUrl(url) {
  return /\.(jpg|jpeg|mjpg|mjpeg)|snapshot|mjpeg/i.test(url || '');
}

export function isHlsUrl(url) {
  return /\.m3u8(\?|$)/i.test(url || '');
}

/** Route local go2rtc through the Vite proxy (same origin → canvas detection works). */
function viaDevProxy(absoluteUrl) {
  if (typeof window === 'undefined' || !absoluteUrl) return absoluteUrl;
  try {
    const u = new URL(absoluteUrl, window.location.origin);
    const localGo2 =
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost') &&
      (u.port === '1984' || u.port === '1990');
    if (localGo2) {
      return `${window.location.origin}/go2rtc${u.pathname}${u.search}`;
    }
  } catch {
    /* ignore */
  }
  return absoluteUrl;
}

/** Still JPEG from the same go2rtc stream, for camera-card previews. */
export function go2rtcSnapshotUrl(url) {
  const play = resolvePlayableUrl(url);
  if (!play || !String(play).includes('/api/stream.mp4')) return null;
  try {
    const parsed = new URL(play, 'http://127.0.0.1');
    const src = parsed.searchParams.get('src');
    if (!src) return null;
    parsed.pathname = parsed.pathname.replace('/api/stream.mp4', '/api/frame.jpeg');
    const path = `${parsed.pathname}${parsed.search}`;
    if (play.startsWith('http://') || play.startsWith('https://')) {
      return `${parsed.origin}${path}`;
    }
    return path;
  } catch {
    return null;
  }
}

/** Prefer go2rtc MSE MP4 for browser playback. */
export function resolvePlayableUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.origin);
    const src = u.searchParams.get('src');
    const isStream =
      src &&
      (u.pathname.includes('/api/stream.m3u8') || u.pathname.includes('/api/stream.mp4'));
    if (isStream) {
      const msePath = `/api/stream.mp4?src=${encodeURIComponent(src)}`;
      // Already on the Vite proxy. Rebuilding from the page origin drops /go2rtc
      // and the second camera is requested from the API, which has no video.
      if (u.pathname.startsWith('/go2rtc/')) return `/go2rtc${msePath}`;
      return viaDevProxy(`${u.origin}${msePath}`);
    }
  } catch {
    /* ignore */
  }
  return viaDevProxy(url);
}

export function isBrowserPlayable(url, protocol) {
  if (!url) return false;
  if (isRtspUrl(url, protocol)) return false;
  return true;
}
