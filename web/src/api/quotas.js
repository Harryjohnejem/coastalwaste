import client from './client';

export async function listQuotas() {
  const { data } = await client.get('/quotas');
  return data;
}

export async function createQuota(payload) {
  const { data } = await client.post('/quotas', payload);
  return data;
}

export async function updateQuota(id, payload) {
  const { data } = await client.put(`/quotas/${id}`, payload);
  return data;
}
