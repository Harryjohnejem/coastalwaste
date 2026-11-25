/** Live Detection Log Present-row refresh. Overlay boxes still poll at OVERLAY_POLL_MS. */
export const POLL_INTERVAL_MS = 3000;

/** Records / KPI refresh while a list or report module is open. */
export const RECORDS_POLL_MS = 4000;

/** Detection Reviews table refresh. Training jobs poll only while a job is active. */
export const REVIEW_POLL_MS = 12000;

/** Composition and trend charts. */
export const CHART_POLL_MS = 6000;

/** Poll interval for YOLO live overlay boxes (ms). */
export const OVERLAY_POLL_MS = 200;

/** Delay before the first overlay poll (ms). Keep low for near-real-time HUD. */
export const OVERLAY_START_DELAY_MS = 250;

/** Live detector file. This is the model the camera actually runs. */
/** Fallback until Settings loads; the real name comes from the server (Deploy/Rollback). */
export const LIVE_MODEL_NAME = 'YOLOv11l / Roboflow';

/** Models present in the detector folder. */
export const MODEL_OPTIONS = [
  LIVE_MODEL_NAME,
  'YOLOv8n · yolov8n.pt',
  'YOLOv8s-Worldv2 · yolov8s-worldv2.pt',
];

/** Review and record class list. Live weights 11 does not include Plastic Bag. */
export const WASTE_CLASSES = [
  'Can',
  'Cardboard',
  'Ecobag',
  'Face Mask',
  'Glass Bottle',
  'Paper Bag',
  'Paper Drink Carton',
  'Plastic Bag',
  'Plastic Bottle',
  'Plastic Cellophane',
  'Plastic Cup',
  'Plastic Spoon',
  'Plastic Wrapper',
  'Styro Cup',
  'Styrofoam',
];

/** Classes switched off for live detection (detector EXCLUDED_CLASSES). Plastic Spoon is detected. */
export const LIVE_EXCLUDED_CLASSES = ['Cardboard', 'Paper Bag', 'Paper Drink Carton', 'Plastic Bag'];

/** Classes the live detector draws and records. Settings shows and saves this list. */
export const LIVE_DETECTION_CLASSES = WASTE_CLASSES.filter(
  (name) => !LIVE_EXCLUDED_CLASSES.includes(name),
);

/** Clip lengths offered for the Live Monitoring Record button (seconds). */
export const RECORDING_LENGTH_OPTIONS = [
  { seconds: 15, label: '15 seconds' },
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 180, label: '3 minutes' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 600, label: '10 minutes' },
];
export const DEFAULT_RECORDING_SECONDS = 60;

export function recordingLengthLabel(seconds) {
  const match = RECORDING_LENGTH_OPTIONS.find((o) => o.seconds === Number(seconds));
  return match ? match.label : '1 minute';
}

export const PARENT_CATEGORIES = ['Plastic', 'Metal', 'Glass'];

/** Official YOLOv11l classifications mapped to the visible parent categories. */
export const CATEGORY_BY_CLASS = {
  'Face Mask': 'Plastic',
  Ecobag: 'Plastic',
  'Plastic Bag': 'Plastic',
  'Plastic Bottle': 'Plastic',
  'Plastic Cellophane': 'Plastic',
  'Plastic Cup': 'Plastic',
  'Plastic Spoon': 'Plastic',
  'Plastic Wrapper': 'Plastic',
  'Styro Cup': 'Plastic',
  Styrofoam: 'Plastic',
  Cardboard: 'Paper',
  'Paper Bag': 'Paper',
  'Paper Drink Carton': 'Paper',
  Can: 'Metal',
  'Glass Bottle': 'Glass',
};

export const THEME_STORAGE_KEY = 'tidalwatch-theme';
export const AUTH_STORAGE_KEY = 'tidalwatch-auth';

/** Set while the welcome window waits for a click; a refresh shows it again. */
export const WELCOME_PENDING_KEY = 'tidalwatch-welcome-pending';
export const CAMERAS_STORAGE_KEY = 'tidalwatch-cameras';

export const RTSP_GATEWAY_MESSAGE =
  'RTSP streams need a gateway (MediaMTX / go2rtc). Point this camera at its HLS or WebRTC output.';
