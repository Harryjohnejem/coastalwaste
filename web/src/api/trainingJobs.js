import client from './client';

export async function listTrainingJobs(params = {}, config = {}) {
  const { data } = await client.get('/training-jobs', { timeout: 20000, params, ...config });
  return data;
}

export async function startTrainingJob() {
  const { data } = await client.post('/training-jobs', {}, { timeout: 60000 });
  return data;
}

export async function updateTrainingSampleLimit(perClass) {
  const { data } = await client.put('/training-jobs/sample-limit', { per_class: perClass });
  return data;
}

export async function pickTrainingData(id) {
  const { data } = await client.post(`/training-jobs/${id}/pick-data`, {}, { timeout: 300000 });
  return data;
}

export async function startRoboflowRecipe(id, recipe = { architecture: 'yolov11', model_size: 'large', epochs: 350 }) {
  const { data } = await client.post(`/training-jobs/${id}/start-training`, recipe, { timeout: 300000 });
  return data;
}

export async function retryTrainingJob(id) {
  const { data } = await client.post(`/training-jobs/${id}/retry`, {}, { timeout: 300000 });
  return data;
}

export async function dismissTrainingJob(id) {
  const { data } = await client.post(`/training-jobs/${id}/dismiss`);
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
  const { data } = await client.post(`/training-jobs/${id}/deploy`, {}, { timeout: 900000 });
  return data;
}

export async function rollbackTrainingJob(id) {
  const { data } = await client.post(`/training-jobs/${id}/rollback`, {}, { timeout: 300000 });
  return data;
}
