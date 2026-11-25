// Detection On/Off survives a page refresh even while Laravel is still
// saving: the choice is kept here until the API confirms it.
const DETECTION_KEY = 'tidalwatch-detection-enabled';

export function readDetectionChoice() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DETECTION_KEY) || 'null');
    if (raw && typeof raw.value === 'boolean') {
      return { value: raw.value, pending: raw.pending === true };
    }
  } catch {
    // Storage blocked or corrupt: fall back to the API value.
  }
  return null;
}

export function writeDetectionChoice(value, pending) {
  try {
    window.localStorage.setItem(DETECTION_KEY, JSON.stringify({ value: Boolean(value), pending: Boolean(pending) }));
  } catch {
    // Storage blocked: the API value still applies after a refresh.
  }
}
