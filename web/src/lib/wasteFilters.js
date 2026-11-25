import { CATEGORY_BY_CLASS, PARENT_CATEGORIES, WASTE_CLASSES } from '../constants';
import { datasetAttributionOf, datasetFilterKeyOf } from './datasetSource';

/** Parent categories (Plastic, Metal, Glass, then any added in the catalog). Same array, kept current. */
export const WASTE_CATEGORIES = PARENT_CATEGORIES;
const HIDDEN_CATEGORIES = new Set(['paper', 'fishing gear', 'other', 'styrofoam', 'wood']);
const HIDDEN_CLASSIFICATIONS = new Set([
  'cardboard', 'paper bag', 'paper drink carton', 'plastic bag', 'other plastic', 'aluminum',
  'scrap metal', 'tin can', 'glass fragment', 'fishing line', 'fishing net',
  'coastal debris', 'litter', 'unknown', 'driftwood', 'drift wood',
  'pallet / lumber', 'pallet/lumber', 'wood debris',
]);

/** Known classifications nested under each parent category, built from the current lists. */
export function wasteSubtypes() {
  return Object.fromEntries(
    PARENT_CATEGORIES.map((category) => [
      category,
      WASTE_CLASSES.filter((name) => CATEGORY_BY_CLASS[name] === category),
    ]),
  );
}

function officialClass(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return (
    WASTE_CLASSES.find((name) => name.toLowerCase() === raw) ||
    Object.keys(CATEGORY_BY_CLASS).find((name) => name.toLowerCase() === raw) ||
    ''
  );
}

/** Map a detection to its category and classification, including catalog names. */
export function classifyWaste(det) {
  const storedSubtype = String(det?.waste_subtype || det?.class || det?.dataset_class || '').trim();
  const official = officialClass(storedSubtype);
  if (official) {
    return { category: CATEGORY_BY_CLASS[official] || '', subtype: official };
  }
  const category = String(det?.waste_category || det?.parent_category || '').trim();
  if (category || storedSubtype) {
    return { category, subtype: storedSubtype };
  }
  return { category: '', subtype: '' };
}

function sameName(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

/** Official categories plus every category and classification saved in the catalog. */
export function listsFromCatalog(catalog = []) {
  const categories = [...WASTE_CATEGORIES];
  const subtypes = Object.fromEntries(
    Object.entries(wasteSubtypes()).map(([key, values]) => [
      key,
      values.filter((name) => !HIDDEN_CLASSIFICATIONS.has(name.toLowerCase())),
    ]),
  );

  for (const category of catalog || []) {
    const rawName = String(category?.name || '').trim();
    if (!rawName || HIDDEN_CATEGORIES.has(rawName.toLowerCase())) continue;
    let bucket = categories.find((name) => sameName(name, rawName));
    if (!bucket) {
      categories.push(rawName);
      bucket = rawName;
      subtypes[bucket] = [];
    }
    const list = subtypes[bucket] || (subtypes[bucket] = []);
    for (const row of category.classifications || []) {
      const className = String(row?.name || '').trim();
      if (!className || HIDDEN_CLASSIFICATIONS.has(className.toLowerCase()) || list.some((name) => sameName(name, className))) continue;
      list.push(className);
    }
  }

  return { categories, subtypes };
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
      if (datasetFilterKeyOf(d) !== attrFilter) return false;
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
