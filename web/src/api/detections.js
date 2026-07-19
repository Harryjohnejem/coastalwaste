import client from './client';

export async function listDetections(limit = 50) {
  const { data } = await client.get('/detections', { params: { limit } });
  return data;
}

export async function createDetection(payload) {
  const body = {
    camera_id: payload.camera_id || null,
    class: payload.class,
    confidence: payload.confidence,
    count: payload.count ?? 1,
    sector: payload.sector || null,
    severity: payload.severity || 'alert',
    subtitle: payload.subtitle || null,
  };
  const { data } = await client.post('/detections', body);
  return data;
}

export async function getLiveOverlay(cameraId) {
  const { data } = await client.get('/detections/live', {
    params: { camera_id: cameraId },
  });
  return data;
}

export async function getTodayStats() {
  const { data } = await client.get('/stats/today');
  return data;
}

export async function getComposition(range = '24h') {
  const { data } = await client.get('/stats/composition', { params: { range } });
  return data;
}
