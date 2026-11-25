import client from './client';

const DETECTOR_RUNTIME_URL = (
  import.meta.env.VITE_DETECTOR_OVERLAY_URL || 'http://127.0.0.1:8092/overlay'
).replace(/\/overlay(?:\?.*)?$/i, '/runtime/detection');

export async function getSettings() {
  const { data } = await client.get('/settings');
  return data;
}

export async function updateSettings(payload) {
  const { data } = await client.put('/settings', payload);
  return data;
}

export async function pingDetectorEnabled(enabled) {
  try {
    await fetch(DETECTOR_RUNTIME_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: Boolean(enabled) }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    /* Laravel save still proceeds. */
  }
}
