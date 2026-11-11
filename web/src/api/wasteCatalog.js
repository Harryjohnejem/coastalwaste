import client from './client';

export async function listWasteCatalog() {
  const { data } = await client.get('/waste-catalog');
  return data;
}

export async function createWasteCategory(payload) {
  const { data } = await client.post('/waste-catalog/categories', payload);
  return data;
}

export async function createWasteClassification(payload) {
  const { data } = await client.post('/waste-catalog/classifications', payload);
  return data;
}
