/** Template mock data — used until API responds; also seeds optimistic UI. */

export const MOCK_CAMERAS = [
  {
    id: 'CAM-01',
    name: 'CAM-01 · Pier Overlook',
    sector: 'Sector B',
    stream_url: 'rtsp://192.168.1.64:554',
    protocol: 'RTSP',
    status: 'live',
    detections_per_hour: 12,
    resolution: '1920 × 1080',
    fps: '25 FPS',
  },
  {
    id: 'CAM-02',
    name: 'CAM-02 · Mangrove Edge',
    sector: 'Sector E',
    stream_url: 'rtsp://192.168.1.65:554',
    protocol: 'RTSP',
    status: 'live',
    detections_per_hour: 7,
    resolution: '1920 × 1080',
    fps: '25 FPS',
  },
  {
    id: 'CAM-03',
    name: 'CAM-03 · Estuary Mouth',
    sector: 'Sector B',
    stream_url: 'rtsp://192.168.1.66:554',
    protocol: 'RTSP',
    status: 'live',
    detections_per_hour: 21,
    resolution: '1920 × 1080',
    fps: '25 FPS',
  },
  {
    id: 'CAM-04',
    name: 'CAM-04 · South Breakwater',
    sector: 'Sector F',
    stream_url: 'rtsp://192.168.1.67:554',
    protocol: 'RTSP',
    status: 'offline',
    detections_per_hour: null,
    resolution: '1920 × 1080',
    fps: '25 FPS',
  },
];

export const MOCK_STATS = {
  detections: 147,
  debris_kg: 32.4,
  hotspots: { flagged: 2, total: 6, labels: 'B, E flagged' },
  reports_filed: 5,
  deltas: {
    detections: { direction: 'up', text: '▲ 18% vs yesterday' },
    debris_kg: { direction: 'up', text: '▲ 4.1 kg since 06:00' },
    hotspots: { direction: 'neutral', text: 'B, E flagged' },
    reports_filed: { direction: 'down', text: 'All acknowledged' },
  },
};

export const MOCK_DETECTIONS = [
  {
    id: 'd1',
    camera_id: 'CAM-03',
    class: 'Plastic bottle cluster',
    confidence: 0.94,
    count: 4,
    sector: 'Sector B',
    detected_at: '14:32:08',
    severity: 'alert',
    subtitle: '4 objects · intertidal zone',
  },
  {
    id: 'd2',
    camera_id: 'CAM-01',
    class: 'Abandoned fishing net',
    confidence: 0.81,
    count: 1,
    sector: 'Sector B',
    detected_at: '14:17:41',
    severity: 'warn',
    subtitle: 'entanglement risk · large item',
  },
  {
    id: 'd3',
    camera_id: 'CAM-02',
    class: 'Styrofoam fragments',
    confidence: 0.88,
    count: 9,
    sector: 'Sector E',
    detected_at: '13:58:22',
    severity: 'alert',
    subtitle: '9 objects · drifting inshore',
  },
  {
    id: 'd4',
    camera_id: 'CAM-01',
    class: 'Sector A sweep clear',
    confidence: null,
    count: 0,
    sector: 'Sector A',
    detected_at: '13:30:00',
    severity: 'info',
    subtitle: 'scheduled scan · no debris found',
  },
  {
    id: 'd5',
    camera_id: null,
    class: 'Debris density rising',
    confidence: null,
    count: 0,
    sector: 'Sector E',
    detected_at: '13:12:55',
    severity: 'warn',
    subtitle: 'threshold 70% reached',
  },
];

export const MOCK_COMPOSITION = [
  { label: 'Plastics', percent: 58 },
  { label: 'Fishing gear', percent: 19 },
  { label: 'Styrofoam', percent: 14 },
  { label: 'Other', percent: 9 },
];

export const MOCK_SETTINGS = {
  stream: {
    url: '',
    protocol: 'RTSP (via gateway)',
    transport: 'TCP',
    username: '',
    password: '',
    resolution: '1920 × 1080',
    fps: '25 FPS',
  },
  detection: {
    model: 'YOLO-World · waste',
    confidence: 0.6,
    interval: 5,
    classes: ['Plastic bottles', 'Plastic bags', 'Fishing nets', 'Styrofoam', 'Metal cans'],
    showBoxes: true,
    showConfidence: true,
  },
  alerts: {
    densityAlerts: true,
    densityThreshold: 70,
    largeItemAlerts: true,
    offlineAlerts: true,
    email: '',
    webhook: '',
    reportFrequency: 'Daily · 06:00',
  },
  station: {
    name: 'Station 01 — North Shoreline',
    lat: '14.3486',
    lon: '121.3244',
    timezone: 'Asia/Manila (UTC+8)',
    saveSnapshots: true,
    retention: '30 days',
    clipLength: '30 seconds',
  },
};

export const ENV_STRIP = {
  tide: '+0.8 m',
  wind: '14 km/h NE',
  visibility: 'Good',
};

export const HUD_COORDS = {
  lat: '14.3486° N',
  lon: '121.3244° E',
  zone: 'Intertidal · Sector B',
};
