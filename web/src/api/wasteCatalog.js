import client from './client';

export async function listWasteCatalog() {
  const { data } = await client.get('/waste-catalog', { timeout: 60000 });
  return data;
}

export async function createWasteCategory(payload) {
  const { data } = await client.post('/waste-catalog/categories', payload, { timeout: 60000 });
  return data;
}

export async function createWasteClassification(payload) {
  const { data } = await client.post('/waste-catalog/classifications', payload, { timeout: 60000 });
  return data;
}
