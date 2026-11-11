/**
 * Training-dataset attribution vs camera detection source.
 *
 * Local 1 (CCTV) and Local 2 (online) were merged into one YOLO model.
 * Live predictions cannot be attributed to either subset from class/confidence alone.
 */

export const DATASET_ATTRIBUTION = {
  LOCAL_1: 'local_1',
  LOCAL_2: 'local_2',
  COMBINED_NOT_ATTRIBUTABLE: 'combined_not_attributable',
  UNKNOWN: 'unknown',
};

const LABELS = {
  [DATASET_ATTRIBUTION.LOCAL_1]: 'Local 1',
  [DATASET_ATTRIBUTION.LOCAL_2]: 'Local 2',
  [DATASET_ATTRIBUTION.COMBINED_NOT_ATTRIBUTABLE]:
    'Combined Model — Source Not Attributable',
  [DATASET_ATTRIBUTION.UNKNOWN]: 'Unknown / Not Attributable',
};

const TOOLTIPS = {
  [DATASET_ATTRIBUTION.LOCAL_1]:
    'Attributed to Local 1 (CCTV / camera training images) by verified data lineage — not inferred from the prediction alone.',
  [DATASET_ATTRIBUTION.LOCAL_2]:
    'Attributed to Local 2 (online-source training images) by verified data lineage — not inferred from the prediction alone.',
  [DATASET_ATTRIBUTION.COMBINED_NOT_ATTRIBUTABLE]:
    'The live model was trained on Local 1 + Local 2 merged together. Individual predictions cannot be attributed to either subset. Camera / Detection Source is separate.',
  [DATASET_ATTRIBUTION.UNKNOWN]:
    'No verified training-dataset attribution is stored. This does not mean Local 1 or Local 2 — the camera that captured the frame is listed under Detection Source.',
};

export function normalizeDatasetAttribution(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (
    raw === DATASET_ATTRIBUTION.LOCAL_1 ||
    raw === 'local1' ||
    raw === 'local_1'
  ) {
    return DATASET_ATTRIBUTION.LOCAL_1;
  }
  if (
    raw === DATASET_ATTRIBUTION.LOCAL_2 ||
    raw === 'local2' ||
    raw === 'local_2'
  ) {
    return DATASET_ATTRIBUTION.LOCAL_2;
  }
  if (
    raw === DATASET_ATTRIBUTION.COMBINED_NOT_ATTRIBUTABLE ||
    raw.includes('combined') ||
    raw.includes('not_attributable')
  ) {
    return DATASET_ATTRIBUTION.COMBINED_NOT_ATTRIBUTABLE;
  }
  return DATASET_ATTRIBUTION.UNKNOWN;
}

export function datasetAttributionOf(det) {
  if (det?.dataset_attribution_label) {
    return String(det.dataset_attribution_label);
  }
  return LABELS[normalizeDatasetAttribution(det?.dataset_attribution)] || LABELS.unknown;
}

export function datasetAttributionCodeOf(det) {
  if (det?.dataset_attribution) {
    return normalizeDatasetAttribution(det.dataset_attribution);
  }
  return DATASET_ATTRIBUTION.UNKNOWN;
}

export function datasetAttributionTooltipOf(det) {
  if (det?.dataset_attribution_tooltip) {
    return String(det.dataset_attribution_tooltip);
  }
  return TOOLTIPS[datasetAttributionCodeOf(det)] || TOOLTIPS.unknown;
}

export function trainingDatasetLabelOf(det) {
  return (
    det?.training_dataset_label ||
    det?.training_dataset ||
    'Unknown / Not recorded'
  );
}

export function detectionSourceOf(det) {
  return det?.detection_source || det?.camera_id || '—';
}

/** Build filter options only from values present in the current record set. */
export function datasetAttributionFilterOptions(detections = []) {
  const present = new Set();
  detections.forEach((d) => present.add(datasetAttributionCodeOf(d)));
  const order = [
    DATASET_ATTRIBUTION.LOCAL_1,
    DATASET_ATTRIBUTION.LOCAL_2,
    DATASET_ATTRIBUTION.COMBINED_NOT_ATTRIBUTABLE,
    DATASET_ATTRIBUTION.UNKNOWN,
  ];
  const opts = [{ value: 'All Sources', label: 'All Dataset Sources' }];
  order.forEach((code) => {
    if (present.has(code)) {
      opts.push({ value: code, label: LABELS[code] });
    }
  });
  return opts;
}
