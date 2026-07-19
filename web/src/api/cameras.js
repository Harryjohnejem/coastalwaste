import client from './client';

export async function listCameras() {
  const { data } = await client.get('/cameras');
  return data;
}

export async function createCamera(payload) {
  const { data } = await client.post('/cameras', payload);
  return data;
}

export async function updateCamera(id, payload) {
  const { data } = await client.put(`/cameras/${id}`, payload);
  return data;
}

export async function deleteCamera(id) {
  const { data } = await client.delete(`/cameras/${id}`);
  return data;
}

/** POST /cameras/{id}/test → { ok: bool, latency_ms } */
export async function testCamera(id) {
  const { data } = await client.post(`/cameras/${id}/test`);
  return data;
}
