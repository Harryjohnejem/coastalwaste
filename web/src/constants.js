/** Live Detection Log Present-row refresh. Overlay boxes still poll at OVERLAY_POLL_MS. */
export const POLL_INTERVAL_MS = 2000;

/** Records / KPI refresh while a list or report module is open. */
export const RECORDS_POLL_MS = 8000;

/** Detection Reviews table refresh. Training jobs poll faster only while a job is active. */
export const REVIEW_POLL_MS = 5000;

/** Composition and trend charts. */
export const CHART_POLL_MS = 15000;

/** Poll interval for YOLO live overlay boxes (ms). */
export const OVERLAY_POLL_MS = 200;

/** Delay before the first overlay poll (ms). Keep low for near-real-time HUD. */
export const OVERLAY_START_DELAY_MS = 250;

/** Live detector file. This is the model the camera actually runs. */
export const LIVE_MODEL_NAME = 'YOLOv11n ONNX · best.onnx';

/** Models present in the detector folder. */
export const MODEL_OPTIONS = [
  LIVE_MODEL_NAME,
  'YOLOv8n · yolov8n.pt',
  'YOLOv8s-Worldv2 · yolov8s-worldv2.pt',
];

/** Same order as the live YOLOv11n ONNX model (weights 4, CCTV). */
export const WASTE_CLASSES = [
  'Can',
  'Cardboard',
  'Ecobag',
  'Face Mask',
  'Glass Bottle',
  'Paper Bag',
  'Paper Drink Carton',
  'Plastic Bottle',
  'Plastic Cellophane',
  'Plastic Cup',
  'Plastic Wrapper',
  'Styro Cup',
  'Styrofoam',
];

export const PARENT_CATEGORIES = ['Plastic', 'Paper', 'Metal', 'Glass'];

/** Official YOLOv11s classification → one of the four parent categories. */
export const CATEGORY_BY_CLASS = {
  'Face Mask': 'Plastic',
  Ecobag: 'Plastic',
  'Plastic Bag': 'Plastic',
  'Plastic Bottle': 'Plastic',
  'Plastic Cellophane': 'Plastic',
  'Plastic Cup': 'Plastic',
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

export const RTSP_GATEWAY_MESSAGE =
  'RTSP streams need a gateway (MediaMTX / go2rtc). Point this camera at its HLS or WebRTC output.';
