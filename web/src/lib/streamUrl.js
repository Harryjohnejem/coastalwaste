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

/** Prefer go2rtc MSE MP4 for browser playback. */
export function resolvePlayableUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.origin);
    const src = u.searchParams.get('src');
    if (
      src &&
      (u.pathname.includes('/api/stream.m3u8') || u.pathname.includes('/api/stream.mp4'))
    ) {
      const mse = `${u.origin}/api/stream.mp4?src=${encodeURIComponent(src)}`;
      return viaDevProxy(mse);
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
