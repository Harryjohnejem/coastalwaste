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
  const { data } = await client.put(`/cameras/${encodeURIComponent(id)}`, payload);
  return data;
}

export async function deleteCamera(id) {
  const { data } = await client.delete(`/cameras/${encodeURIComponent(id)}`, { timeout: 60000 });
  return data;
}

/** POST /cameras/{id}/test → { ok: bool, latency_ms } */
/** Test an IP camera before saving: the gateway must return a real picture. */
export async function probeCamera(payload) {
  const { data } = await client.post('/cameras/probe', payload, { timeout: 30000 });
  return data;
}

export async function testCamera(id) {
  const { data } = await client.post(`/cameras/${id}/test`);
  return data;
}
