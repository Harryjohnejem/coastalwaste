import client from './client';

export async function listMissedDetectionIds(params = {}, config = {}) {
  const { data } = await client.get('/missed-detections', {
    params: { ...params, ids_only: 1 },
    timeout: 30000,
    ...config,
    priority: 'high',
  });
  return Array.isArray(data?.ids)
    ? data.ids.map(Number).filter((id) => Number.isInteger(id))
    : [];
}

export async function listMissedDetections(params = {}, config = {}) {
  const { data } = await client.get('/missed-detections', {
    params,
    timeout: 20000,
    ...config,
    priority: 'high',
  });
  return data;
}

export async function createMissedDetection(formData) {
  const { data } = await client.post('/missed-detections', formData);
  return data;
}

export async function saveMissedAnnotations(id, annotations) {
  const { data } = await client.put(`/missed-detections/${id}/annotations`, { annotations }, { timeout: 30000 });
  return data;
}

export async function reviewMissedDetection(id, decision, includeInExport) {
  const body = { decision };
  if (includeInExport !== undefined) body.include_in_export = includeInExport;
  const { data } = await client.post(`/missed-detections/${id}/review`, body, { timeout: 30000 });
  return data;
}

export async function deleteMissedDetection(id) {
  const { data } = await client.delete(`/missed-detections/${id}`, { timeout: 30000 });
  return data;
}

export async function deleteMissedDetections(ids) {
  const { data } = await client.post('/missed-detections/bulk-delete', { ids }, { timeout: 120000 });
  return data;
}

export async function exportApprovedDataset() {
  const response = await client.get('/missed-detections/export', { responseType: 'blob' });
  return response.data;
}
