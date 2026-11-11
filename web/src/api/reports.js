import client from './client';

export async function createReport(payload = {}) {
  const { data } = await client.post('/reports', payload);
  return data;
}

export async function emailReport(payload) {
  const { data } = await client.post('/reports/email', payload, { timeout: 90000 });
  return data;
}
