import { CATEGORY_BY_CLASS, PARENT_CATEGORIES, WASTE_CLASSES } from '../constants';
import { datasetClassOf, parentCategoryOf } from './reportForm';

export const DATE_OPTIONS = [
  'All Dates',
  'Today',
  'Yesterday',
  'Last 7 Days',
  'Last 30 Days',
  'This Month',
  'Last Month',
  'Custom Range',
];

export const CATEGORY_COLORS = {
  Plastic: '#2DD4BF',
  Paper: '#4DA3FF',
  Metal: '#F5B942',
  Glass: '#C084FC',
};

export const CLASS_COLORS = [
  '#2DD4BF',
  '#4DA3FF',
  '#F5B942',
  '#F472B6',
  '#A3E635',
  '#FF6E61',
  '#C084FC',
  '#38BDF8',
];

export function qty(d) {
  const n = Number(d?.count ?? d?.quantity ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function detectionTime(d) {
  const raw = d?.detected_at_iso || d?.detected_at;
  if (!raw) return null;
  const t = Date.parse(String(raw).replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/** Inclusive start/end for a named reporting period. Null means unbounded. */
export function periodBounds(dateRange, fromDate, toDate, now = new Date()) {
  const today = startOfDay(now);
  const day = 86400000;
  if (!dateRange || dateRange === 'All Dates') return null;
  if (dateRange === 'Today') return { start: today, end: endOfDay(now) };
  if (dateRange === 'Yesterday') {
    const y = new Date(today.getTime() - day);
    return { start: y, end: endOfDay(y) };
  }
  if (dateRange === 'Last 7 Days') {
    return { start: new Date(today.getTime() - 6 * day), end: endOfDay(now) };
  }
  if (dateRange === 'Last 30 Days') {
    return { start: new Date(today.getTime() - 29 * day), end: endOfDay(now) };
  }
  if (dateRange === 'This Month') {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: endOfDay(now) };
  }
  if (dateRange === 'Last Month') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { start, end };
  }
  if (dateRange === 'Custom Range') {
    const start = fromDate ? new Date(`${fromDate}T00:00:00`) : null;
    const end = toDate ? new Date(`${toDate}T23:59:59`) : null;
    if (!start && !end) return null;
    return {
      start: start && !Number.isNaN(start.getTime()) ? start : new Date(0),
      end: end && !Number.isNaN(end.getTime()) ? end : endOfDay(now),
    };
  }
  return null;
}

/** Immediately preceding range of equal duration (calendar months keep month length). */
export function previousPeriodBounds(bounds, dateRange) {
  if (!bounds?.start || !bounds?.end) return null;
  if (dateRange === 'This Month' || dateRange === 'Last Month') {
    const start = new Date(bounds.start.getFullYear(), bounds.start.getMonth() - 1, 1);
    const end = new Date(bounds.start.getFullYear(), bounds.start.getMonth(), 0, 23, 59, 59, 999);
    return { start, end };
  }
  if (dateRange === 'Today' || dateRange === 'Yesterday') {
    const start = new Date(bounds.start.getTime() - 86400000);
    return { start, end: endOfDay(start) };
  }
  const duration = bounds.end.getTime() - bounds.start.getTime();
  const end = new Date(bounds.start.getTime() - 1);
  const start = new Date(end.getTime() - duration);
  return { start, end };
}

export function inBounds(d, bounds) {
  if (!bounds) return true;
  const t = detectionTime(d);
  if (t == null) return false;
  if (bounds.start && t < bounds.start.getTime()) return false;
  if (bounds.end && t > bounds.end.getTime()) return false;
  return true;
}

export function formatPeriodLabel(dateRange, fromDate, toDate, bounds) {
  if (dateRange === 'Custom Range') {
    if (fromDate && toDate) return `${fromDate} to ${toDate}`;
    if (fromDate) return `from ${fromDate}`;
    if (toDate) return `through ${toDate}`;
  }
  if (bounds?.start && bounds?.end && dateRange !== 'Today' && dateRange !== 'Yesterday') {
    const opts = { month: 'short', day: 'numeric' };
    return `${dateRange} · ${bounds.start.toLocaleDateString('en-PH', opts)} – ${bounds.end.toLocaleDateString('en-PH', opts)}`;
  }
  return dateRange;
}

export function formatShortDate(date) {
  return date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

export function countItems(list) {
  return (list || []).reduce((sum, d) => sum + qty(d), 0);
}

export function classCounts(list) {
  const counts = Object.fromEntries(WASTE_CLASSES.map((name) => [name, 0]));
  (list || []).forEach((d) => {
    const name = datasetClassOf(d);
    if (!name) return;
    counts[name] += qty(d);
  });
  return counts;
}

export function categoryCounts(list) {
  const counts = Object.fromEntries(PARENT_CATEGORIES.map((name) => [name, 0]));
  (list || []).forEach((d) => {
    const name = parentCategoryOf(d);
    if (!name) return;
    counts[name] += qty(d);
  });
  return counts;
}

export function rankedClasses(list, limit = 5) {
  const totals = classCounts(list);
  const grand = Object.values(totals).reduce((s, n) => s + n, 0);
  return WASTE_CLASSES.filter((name) => totals[name] > 0)
    .sort((a, b) => totals[b] - totals[a] || a.localeCompare(b))
    .slice(0, limit)
    .map((name, index) => ({
      rank: index + 1,
      label: name,
      category: CATEGORY_BY_CLASS[name] || '',
      count: totals[name],
      percent: grand > 0 ? Math.round((totals[name] / grand) * 100) : 0,
      color: CLASS_COLORS[index % CLASS_COLORS.length],
    }));
}

export function categoryRows(list) {
  const totals = categoryCounts(list);
  const classTotals = classCounts(list);
  const grand = PARENT_CATEGORIES.reduce((s, name) => s + totals[name], 0);
  return PARENT_CATEGORIES.map((label, index) => ({
    label,
    count: totals[label],
    percent: grand > 0 ? Math.round((totals[label] / grand) * 100) : 0,
    color: CATEGORY_COLORS[label] || CLASS_COLORS[index],
    classifications: WASTE_CLASSES.filter((name) => CATEGORY_BY_CLASS[name] === label).map(
      (name) => ({ label: name, count: classTotals[name] }),
    ),
  })).sort((a, b) => b.count - a.count);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function bucketDaily(list, bounds, now = new Date()) {
  const end = bounds?.end || endOfDay(now);
  const start = bounds?.start || new Date(startOfDay(now).getTime() - 6 * 86400000);
  const days = [];
  const cursor = startOfDay(start);
  const last = startOfDay(end);
  const maxDays = 31;
  while (cursor.getTime() <= last.getTime() && days.length < maxDays) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  const byDay = Object.fromEntries(days.map((d) => [dayKey(d), 0]));
  (list || []).forEach((d) => {
    const t = detectionTime(d);
    if (t == null) return;
    const key = dayKey(new Date(t));
    if (key in byDay) byDay[key] += qty(d);
  });
  return days.map((d) => ({
    label: d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }),
    key: dayKey(d),
    value: byDay[dayKey(d)] || 0,
    isToday: dayKey(d) === dayKey(now),
  }));
}

export function bucketWeekly(list, bounds, now = new Date()) {
  const end = bounds?.end || endOfDay(now);
  const start = bounds?.start || new Date(startOfDay(now).getTime() - 27 * 86400000);
  const weeks = [];
  const cursor = startOfDay(start);
  const weekday = cursor.getDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  cursor.setDate(cursor.getDate() + mondayOffset);
  const last = startOfDay(end);
  while (cursor.getTime() <= last.getTime() && weeks.length < 8) {
    const weekStart = new Date(cursor);
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weeks.push({ start: weekStart, end: weekEnd });
    cursor.setDate(cursor.getDate() + 7);
  }
  return weeks.map((week) => {
    const value = (list || []).reduce((sum, d) => {
      const t = detectionTime(d);
      if (t == null) return sum;
      if (t < week.start.getTime() || t > endOfDay(week.end).getTime()) return sum;
      return sum + qty(d);
    }, 0);
    const isCurrent =
      now.getTime() >= week.start.getTime() && now.getTime() <= endOfDay(week.end).getTime();
    return {
      label: `${formatShortDate(week.start)}–${formatShortDate(week.end)}`,
      value,
      isCurrent,
    };
  });
}

export function bucketMonthly(list, bounds, now = new Date()) {
  const end = bounds?.end || endOfDay(now);
  const start = bounds?.start || new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const months = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cursor.getTime() <= last.getTime() && months.length < 12) {
    months.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months.map((month) => {
    const mStart = new Date(month.getFullYear(), month.getMonth(), 1).getTime();
    const mEnd = new Date(month.getFullYear(), month.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
    const counts = Object.fromEntries(PARENT_CATEGORIES.map((name) => [name, 0]));
    let total = 0;
    (list || []).forEach((d) => {
      const t = detectionTime(d);
      if (t == null || t < mStart || t > mEnd) return;
      const cat = parentCategoryOf(d);
      const n = qty(d);
      total += n;
      if (cat && cat in counts) counts[cat] += n;
    });
    return {
      label: month.toLocaleDateString('en-PH', { month: 'short' }),
      year: month.getFullYear(),
      total,
      counts,
    };
  });
}

export function percentChange(current, previous) {
  if (previous == null) return null;
  if (previous === 0) {
    if (current === 0) return { direction: 'same', percent: 0, label: 'No change' };
    return { direction: 'up', percent: null, label: 'No previous records to compare' };
  }
  const raw = ((current - previous) / previous) * 100;
  const percent = Math.round(raw);
  if (percent === 0) return { direction: 'same', percent: 0, label: 'Unchanged' };
  return {
    direction: percent > 0 ? 'up' : 'down',
    percent: Math.abs(percent),
    label: `${percent > 0 ? 'Up' : 'Down'} ${Math.abs(percent)}%`,
  };
}

export function confidenceLabel(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const pct = n <= 1 ? n * 100 : n;
  return `${Math.round(pct)}%`;
}

export function matchesCameraAndQuery(d, cameraFilter, recordQuery) {
  if (cameraFilter && cameraFilter !== 'All Cameras' && (d.camera_id || 'CAM-01') !== cameraFilter) {
    return false;
  }
  const q = (recordQuery || '').trim().toLowerCase();
  if (!q) return true;
  const subtype = datasetClassOf(d);
  const category = parentCategoryOf(d);
  return `${subtype} ${category} ${d.camera_id || ''} ${d.location || ''} ${d.sector || ''}`
    .toLowerCase()
    .includes(q);
}
