/** How often Live Monitor refreshes Detection Log + stats from Laravel. */
export const POLL_INTERVAL_MS = 5000;

/** Poll interval for YOLO live overlay boxes (ms). */
export const OVERLAY_POLL_MS = 2000;

export const THEME_STORAGE_KEY = 'tidalwatch-theme';
export const AUTH_STORAGE_KEY = 'tidalwatch-auth';

export const RTSP_GATEWAY_MESSAGE =
  'RTSP streams need a gateway (MediaMTX / go2rtc). Point this camera at its HLS or WebRTC output.';
