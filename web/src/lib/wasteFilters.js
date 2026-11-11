/** Main waste categories shown in Waste Detections (fallback if API is empty). */
export const WASTE_CATEGORIES = ['Papers', 'Plastics', 'Metals', 'Wood', 'Glass'];

/** Specific classified types nested under each category. */
export const WASTE_SUBTYPES = {
  Papers: ['Paper', 'Cardboard', 'Newspaper', 'Tissue / packaging'],
  Plastics: [
    'Plastic Bottle',
    'Plastic Bag',
    'Styrofoam',
    'Fishing Net',
    'Plastic Cup',
    'Other Plastic',
  ],
  Metals: ['Metal Can', 'Aluminum', 'Scrap Metal'],
  Wood: ['Wood Debris', 'Driftwood', 'Pallet / lumber'],
  Glass: ['Glass Bottle', 'Glass Fragment'],
};

const SUBTYPE_TO_CATEGORY = Object.fromEntries(
  Object.entries(WASTE_SUBTYPES).flatMap(([cat, subs]) => subs.map((s) => [s, cat])),
);

/** Map free-text / model class → { category, subtype }. */
export function classifyWaste(det) {
  if (det?.waste_category && det?.waste_subtype) {
    return { category: det.waste_category, subtype: det.waste_subtype };
  }

  const rawType = String(det?.waste_type || '').trim();
  if (WASTE_CATEGORIES.includes(rawType)) {
    return {
      category: rawType,
      subtype: det?.waste_subtype || WASTE_SUBTYPES[rawType][0],
    };
  }
  if (SUBTYPE_TO_CATEGORY[rawType]) {
    return { category: SUBTYPE_TO_CATEGORY[rawType], subtype: rawType };
  }

  const c = String(det?.class || det?.waste_subtype || '').toLowerCase();

  if (c.includes('cardboard')) return { category: 'Papers', subtype: 'Cardboard' };
  if (c.includes('newspaper')) return { category: 'Papers', subtype: 'Newspaper' };
  if (c.includes('tissue') || c.includes('packaging paper')) {
    return { category: 'Papers', subtype: 'Tissue / packaging' };
  }
  if (c.includes('paper')) return { category: 'Papers', subtype: 'Paper' };

  if (c.includes('bottle') && c.includes('glass')) {
    return { category: 'Glass', subtype: 'Glass Bottle' };
  }
  if (c.includes('glass')) return { category: 'Glass', subtype: 'Glass Fragment' };

  if (c.includes('aluminum') || c.includes('aluminium')) {
    return { category: 'Metals', subtype: 'Aluminum' };
  }
  if (c.includes('scrap') && c.includes('metal')) {
    return { category: 'Metals', subtype: 'Scrap Metal' };
  }
  if (c.includes('can') || c.includes('metal')) {
    return { category: 'Metals', subtype: 'Metal Can' };
  }

  if (c.includes('driftwood')) return { category: 'Wood', subtype: 'Driftwood' };
  if (c.includes('pallet') || c.includes('lumber')) {
    return { category: 'Wood', subtype: 'Pallet / lumber' };
  }
  if (c.includes('wood')) return { category: 'Wood', subtype: 'Wood Debris' };

  if (c.includes('styrofoam') || c.includes('foam')) {
    return { category: 'Plastics', subtype: 'Styrofoam' };
  }
  if (c.includes('fishing') || c.includes('net')) {
    return { category: 'Plastics', subtype: 'Fishing Net' };
  }
  if (c.includes('bag')) return { category: 'Plastics', subtype: 'Plastic Bag' };
  if (c.includes('cup')) return { category: 'Plastics', subtype: 'Plastic Cup' };
  if (c.includes('bottle') || c.includes('plastic')) {
    return { category: 'Plastics', subtype: c.includes('bottle') ? 'Plastic Bottle' : 'Other Plastic' };
  }

  return { category: 'Plastics', subtype: 'Other Plastic' };
}

export function listsFromCatalog(catalog) {
  const categories = [...WASTE_CATEGORIES];
  const subtypes = Object.fromEntries(
    Object.entries(WASTE_SUBTYPES).map(([k, v]) => [k, [...v]]),
  );
  if (!Array.isArray(catalog)) {
    return { categories, subtypes };
  }
  catalog.forEach((row) => {
    const name = String(row?.name || '').trim();
    if (!name) return;
    if (!categories.includes(name)) categories.push(name);
    const extra = (row.classifications || []).map((c) => String(c.name || '').trim()).filter(Boolean);
    subtypes[name] = [...new Set([...(subtypes[name] || []), ...extra])];
  });
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
    if (q) {
      const hay = `${category} ${subtype} ${loc} ${cam} ${d.class || ''} ${d.sector || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
