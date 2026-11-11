import client from './client';

export async function listMissedDetections(params = {}, config = {}) {
  const { data } = await client.get('/missed-detections', { params, timeout: 20000, ...config });
  return data;
}

export async function createMissedDetection(formData) {
  const { data } = await client.post('/missed-detections', formData);
  return data;
}

export async function saveMissedAnnotations(id, annotations) {
  const { data } = await client.put(`/missed-detections/${id}/annotations`, { annotations });
  return data;
}

export async function reviewMissedDetection(id, decision, includeInExport) {
  const body = { decision };
  if (includeInExport !== undefined) body.include_in_export = includeInExport;
  const { data } = await client.post(`/missed-detections/${id}/review`, body);
  return data;
}

export async function deleteMissedDetection(id) {
  const { data } = await client.delete(`/missed-detections/${id}`);
  return data;
}

export async function exportApprovedDataset() {
  const response = await client.get('/missed-detections/export', { responseType: 'blob' });
  return response.data;
}
