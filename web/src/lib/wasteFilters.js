import { CATEGORY_BY_CLASS, PARENT_CATEGORIES, WASTE_CLASSES } from '../constants';
import { datasetAttributionCodeOf, datasetAttributionOf } from './datasetSource';

/** Official parent categories for the current dataset. */
export const WASTE_CATEGORIES = [...PARENT_CATEGORIES];

/** YOLO11x classifications nested under the four parent categories. */
export const WASTE_SUBTYPES = Object.fromEntries(
  PARENT_CATEGORIES.map((category) => [
    category,
    WASTE_CLASSES.filter((name) => CATEGORY_BY_CLASS[name] === category),
  ]),
);

function officialClass(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return (
    WASTE_CLASSES.find((name) => name.toLowerCase() === raw) ||
    Object.keys(CATEGORY_BY_CLASS).find((name) => name.toLowerCase() === raw) ||
    ''
  );
}

/** Map a detection to an official classification and one of the four categories. */
export function classifyWaste(det) {
  const name =
    officialClass(det?.dataset_class) ||
    officialClass(det?.waste_subtype) ||
    officialClass(det?.class);
  if (name) {
    return { category: CATEGORY_BY_CLASS[name], subtype: name };
  }
  return { category: '', subtype: '' };
}

export function listsFromCatalog() {
  return {
    categories: [...WASTE_CATEGORIES],
    subtypes: Object.fromEntries(
      Object.entries(WASTE_SUBTYPES).map(([k, v]) => [k, [...v]]),
    ),
  };
}

export function wasteTypeOf(det) {
  return classifyWaste(det).category;
}

export function wasteSubtypeOf(det) {
  return classifyWaste(det).subtype;
}

function detectionTime(det) {
  const raw = det?.detected_at_iso || det?.detected_at;
  if (!raw) return null;
  const t = Date.parse(String(raw).replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

export function inDateRange(det, filters) {
  const range = filters?.dateRange || 'All Dates';
  if (!range || range === 'All Dates') return true;

  const t = detectionTime(det);
  if (t == null) return true;

  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400000;

  if (range === 'Today') return t >= startToday;
  if (range === 'Yesterday') return t >= startToday - day && t < startToday;
  if (range === 'Last 7 Days') return t >= startToday - 7 * day;
  if (range === 'Last 30 Days') return t >= startToday - 30 * day;
  if (range === 'This Month') {
    return t >= new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }
  if (range === 'Last Month') {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    const to = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return t >= from && t < to;
  }
  if (range === 'Custom Range') {
    if (filters.from) {
      const from = Date.parse(`${filters.from}T00:00:00`);
      if (!Number.isNaN(from) && t < from) return false;
    }
    if (filters.to) {
      const to = Date.parse(`${filters.to}T23:59:59`);
      if (!Number.isNaN(to) && t > to) return false;
    }
  }
  return true;
}

export function locationOf(det) {
  if (det.location) return det.location;
  const sector = String(det.sector || '');
  if (sector.includes('B') || sector.includes('A')) return 'Paco Beach';
  if (sector.includes('E') || sector.includes('F')) return 'B-MEG Zone 4';
  return det.sector || 'Paco Beach';
}

export function filterDetections(list, filters) {
  const q = (filters.search || '').trim().toLowerCase();
  return list.filter((d) => {
    const { category, subtype } = classifyWaste(d);
    const loc = locationOf(d);
    const cam = d.camera_id || '';

    if (!inDateRange(d, filters)) return false;

    const typeFilter = filters.wasteType;
    if (typeFilter && typeFilter !== 'All Types' && typeFilter !== 'All Categories') {
      if (category !== typeFilter) return false;
    }

    if (filters.wasteSubtype && filters.wasteSubtype !== 'All Classifications') {
      if (subtype !== filters.wasteSubtype) return false;
    }

    if (filters.location && filters.location !== 'All Locations' && loc !== filters.location) {
      return false;
    }
    if (filters.camera && filters.camera !== 'All Cameras' && cam !== filters.camera) {
      return false;
    }
    const attrFilter = filters.datasetSource;
    if (attrFilter && attrFilter !== 'All Sources') {
      if (datasetAttributionCodeOf(d) !== attrFilter) return false;
    }
    if (q) {
      const attr = datasetAttributionOf(d);
      const hay =
        `${category} ${subtype} ${loc} ${cam} ${attr} ${d.class || ''} ${d.sector || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
