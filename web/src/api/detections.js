import client from './client';

async function listDetectionsFromFile(signal) {
  const res = await fetch(`/storage/detections-feed.json?t=${Date.now()}`, {
    cache: 'no-store',
    signal,
  });
  if (!res.ok) return null;
  const payload = await res.json();
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows)) return null;
  return rows;
}

function takePerClass(rows, cap) {
  const used = new Map();
  const kept = [];
  rows.forEach((row) => {
    const key = row?.class || row?.waste_subtype || 'Unknown';
    const count = used.get(key) || 0;
    if (count >= cap) return;
    used.set(key, count + 1);
    kept.push(row);
  });
  return kept;
}

export async function listDetections(limit = 50, params = {}, config = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 1000);
  const perClass = params?.per_class === 1 || params?.per_class === '1';
  const filtered = Boolean(params?.status || params?.camera_id);
  try {
    const { data } = await client.get('/detections', {
      params: { limit: cap, ...params },
      timeout: cap > 200 ? 20000 : 12000,
      ...config,
    });
    return data;
  } catch (err) {
    if (filtered || err?.response || config.signal?.aborted) throw err;
    const rows = await listDetectionsFromFile(config.signal).catch(() => null);
    if (rows) return perClass ? takePerClass(rows, cap) : rows.slice(0, cap);
    throw err;
  }
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

export async function deleteDetections(ids) {
  const { data } = await client.post('/detections/bulk-delete', { ids }, { timeout: 120000 });
  return data;
}

export async function deleteDetection(id) {
  const { data } = await client.delete(`/detections/${id}`, { timeout: 30000 });
  return data;
}

export async function moveDetectionToReview(id) {
  const { data } = await client.post(`/detections/${id}/review`, null, { timeout: 30000 });
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

export async function getTrends() {
  const { data } = await client.get('/stats/trends');
  return data;
}

/** Mark records as physically cleaned (Barangay Sanitary Inspector / administrator only). */
export async function verifyCleaning(ids) {
  const { data } = await client.post('/detections/verify-cleaning', { ids }, { timeout: 60000 });
  return data;
}
