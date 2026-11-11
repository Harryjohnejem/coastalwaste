import client from './client';

export async function listTrainingJobs(params = {}) {
  const { data } = await client.get('/training-jobs', { timeout: 20000, params });
  return data;
}

export async function startTrainingJob() {
  const { data } = await client.post('/training-jobs', {}, { timeout: 60000 });
  return data;
}

export async function retryTrainingJob(id) {
  const { data } = await client.post(`/training-jobs/${id}/retry`);
  return data;
}

export async function evaluateTrainingJob(id, notes) {
  const { data } = await client.post(`/training-jobs/${id}/evaluate`, { notes });
  return data;
}

export async function approveTrainingDeployment(id) {
  const { data } = await client.post(`/training-jobs/${id}/approve-deployment`);
  return data;
}

export async function rejectTrainingJob(id) {
  const { data } = await client.post(`/training-jobs/${id}/reject`);
  return data;
}

export async function deployTrainingJob(id) {
  const { data } = await client.post(`/training-jobs/${id}/deploy`);
  return data;
}

export async function rollbackTrainingJob(id) {
  const { data } = await client.post(`/training-jobs/${id}/rollback`);
  return data;
}
