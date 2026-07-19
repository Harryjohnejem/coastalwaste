import client from './client';

export async function createReport(payload = {}) {
  const { data } = await client.post('/reports', payload);
  return data;
}
