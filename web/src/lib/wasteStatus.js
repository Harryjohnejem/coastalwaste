/**
 * Waste statuses as shown everywhere. The cameras can only say whether waste
 * is still seen; only a person can verify that it was cleaned.
 *
 *   Waste Detected     just saved
 *   Still Present      still seen on camera
 *   No Longer Visible  left the camera view (inferred, NOT cleaning)
 *   Cleaning Verified  checked by the Barangay Sanitary Inspector / an administrator
 */
export const STATUS = {
  DETECTED: 'Detected',
  PRESENT: 'Present',
  NOT_VISIBLE: 'No Longer Visible',
  VERIFIED: 'Cleaning Verified',
  IGNORED: 'Ignored',
};

const JUST_DETECTED_MS = 60 * 1000;

function time(value) {
  const t = value ? new Date(String(value).replace(' ', 'T')).getTime() : NaN;
  return Number.isNaN(t) ? null : t;
}

/** "Waste Detected", "Still Present", "No Longer Visible" or "Cleaning Verified". */
export function statusLabelOf(d) {
  if (d?.status_label) return d.status_label;
  const status = String(d?.status || '');
  if (status === STATUS.DETECTED) return 'Waste Detected';
  if (status === STATUS.PRESENT) {
    const first = time(d?.detected_at_iso || d?.detected_at);
    const last = time(d?.last_seen_at);
    return first && last && last - first > JUST_DETECTED_MS ? 'Still Present' : 'Waste Detected';
  }
  if (status === 'Confirmed Cleaned') return 'No Longer Visible';
  return status;
}

/** CSS modifier for the status pill. */
export function statusClassOf(d) {
  const label = statusLabelOf(d);
  if (label === 'Waste Detected') return 'is-new';
  if (label === 'Still Present') return 'is-present';
  if (label === 'No Longer Visible') return 'is-gone';
  if (label === 'Cleaning Verified') return 'is-verified';
  return '';
}

/** Hover text that says what the status means (and who verified). */
export function statusTitleOf(d) {
  const label = statusLabelOf(d);
  if (label === 'No Longer Visible') {
    return 'Left the camera view. This is inferred from the camera, not proof that the waste was cleaned.';
  }
  if (label === 'Cleaning Verified') {
    const who = d?.cleaning_verified_by ? ` by ${d.cleaning_verified_by}` : '';
    const when = d?.cleaning_verified_at ? ` on ${d.cleaning_verified_at}` : '';
    return `Cleaning verified${who}${when}.`;
  }
  if (label === 'Still Present') return 'Still seen on the camera.';
  if (label === 'Waste Detected') return 'Detected on the camera.';
  return label;
}

export function canVerifyCleaning(d) {
  const status = String(d?.status || '');
  return Boolean(d?.id) && status !== STATUS.VERIFIED && status !== STATUS.IGNORED;
}
