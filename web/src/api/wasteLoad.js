import client from './client';

/** Cleanup threshold: how full each camera's beach is, compared with the limit in Settings. */
export async function getWasteLoad() {
  const { data } = await client.get('/waste-load', { timeout: 15000 });
  return data;
}
