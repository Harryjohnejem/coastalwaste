import client from './client';

export async function createReport(payload = {}) {
  const { data } = await client.post('/reports', payload);
  return data;
}

export async function emailReport(payload) {
  const { data } = await client.post('/reports/email', payload, { timeout: 90000 });
  return data;
}

/** Everything the Today's Report page shows, computed from today's detections. */
export async function getTodayReport(config = {}) {
  const { data } = await client.get('/reports/today', { timeout: 20000, ...config });
  return data;
}

/** Every saved record (compact), for Reports & Analytics and the report form. No 1000-row limit. */
export async function getReportRecords() {
  const { data } = await client.get('/reports/records', { timeout: 60000 });
  return Array.isArray(data) ? data : [];
}
