import { CATEGORY_BY_CLASS, LIVE_EXCLUDED_CLASSES, PARENT_CATEGORIES, WASTE_CLASSES } from '../constants';
import { createReport } from '../api/reports';

/**
 * Classes on the report: every known class (the model's and the waste
 * catalog's) except the excluded ones. Read each time, so new classes show.
 */
function datasetClasses() {
  return WASTE_CLASSES.filter((name) => !LIVE_EXCLUDED_CLASSES.includes(name));
}
/** Dates listed by name on the form; older dates are summed in one row so it fits one long bond page. */
const DATE_ROW_COUNT = 3;

const REPORT_FOOTER =
  'This report contains all waste detections recorded during the selected monitoring period. For additional details, captured images, and interactive analytics, please access the Coastal Waste Monitoring and Reporting System dashboard.';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function avgConfidence(detections) {
  const nums = (detections || [])
    .map((d) => Number(d.confidence))
    .filter((n) => !Number.isNaN(n));
  if (!nums.length) return null;
  const avg = nums.reduce((s, n) => s + (n <= 1 ? n * 100 : n), 0) / nums.length;
  return Math.round(avg * 10) / 10;
}

function qty(d) {
  const n = Number(d?.count ?? d?.quantity ?? 1);
  return Number.isNaN(n) ? 1 : n;
}

export function datasetClassOf(det) {
  const raw = String(det?.dataset_class || det?.waste_subtype || det?.class || '').trim();
  if (!raw) return '';
  return datasetClasses().find((name) => name.toLowerCase() === raw.toLowerCase()) || raw;
}

export function parentCategoryOf(det) {
  const name = datasetClassOf(det);
  if (name && CATEGORY_BY_CLASS[name]) return CATEGORY_BY_CLASS[name];
  return String(det?.waste_category || det?.parent_category || '').trim();
}

function namesInOrder(preferred, counts, { onlyPositiveExtras = false } = {}) {
  const extras = Object.keys(counts || {}).filter((name) => {
    if (preferred.includes(name)) return false;
    return onlyPositiveExtras ? (counts[name] || 0) > 0 : true;
  });
  return [...preferred, ...extras];
}

function categoryCounts(detections) {
  const counts = Object.fromEntries(PARENT_CATEGORIES.map((name) => [name, 0]));
  (detections || []).forEach((d) => {
    const name = parentCategoryOf(d);
    if (!name) return;
    counts[name] = (counts[name] || 0) + qty(d);
  });
  return counts;
}

function detectionDateKey(d) {
  const raw = d?.detected_at || d?.detected_at_iso || '';
  const iso = d?.detected_at_iso;
  const dt = iso ? new Date(iso) : new Date(String(raw).replace(' ', 'T'));
  if (!Number.isNaN(dt.getTime())) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : String(raw).slice(0, 10) || '—';
}

/**
 * Cameras named on the form. `selected` is what the report was made for
 * (All Cameras -> every camera; one camera -> that camera), so the form shows
 * it even when the period has no records. Without it, the cameras in the records.
 */
function cameraList(detections, selected) {
  const chosen = (Array.isArray(selected) ? selected : String(selected || '').split(','))
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  if (chosen.length) return [...new Set(chosen)].sort().join(', ');
  const ids = [...new Set((detections || []).map((d) => d.camera_id).filter(Boolean))];
  return ids.length ? ids.sort().join(', ') : '—';
}

function classCounts(detections) {
  const counts = Object.fromEntries(datasetClasses().map((name) => [name, 0]));
  (detections || []).forEach((d) => {
    const name = datasetClassOf(d);
    if (!name) return;
    counts[name] = (counts[name] || 0) + qty(d);
  });
  return counts;
}

const CLASS_ACTIONS = {
  'Plastic Wrapper':
    'Review camera frames where plastic wrappers repeat and check whether a nearby bin or a short waste-disposal reminder at that stretch of Paco Beach is practical.',
  'Plastic Cellophane':
    'Inspect the same shoreline segment on the next patrol for leftover film and note whether it is washing in or being left on site.',
  'Plastic Bottle':
    'Check whether bottle drop-off or a recycling point is available near the hotspot camera, then schedule a collection pass if bottles keep appearing.',
  'Plastic Bag':
    'Walk the monitored stretch after the next high-use period and collect bags before they move into the waterline.',
  Ecobag:
    'Confirm whether reusable bags are being discarded at the monitored point and include that location in the next cleanup round.',
  'Plastic Cup':
    'Look for nearby stalls or gathering spots that leave cups, and add that point to the inspection route.',
  'Plastic Spoon':
    'Collect plastic spoons on the next shoreline walk and keep them with other small plastic utensils.',
  'Styro Cup':
    'Include styro cups in the next shoreline walk; they fragment easily if left in place.',
  Styrofoam:
    'Prioritize foam pieces in the next collection — they break up quickly once they reach the water.',
  Can:
    'Add the hotspot camera location to the next metal/recyclable pickup rather than mixing cans with mixed trash.',
  Cardboard:
    'If cardboard is clustering near one camera, check for dumped packaging after events and collect it before rain.',
  'Paper Bag':
    'Collect paper bags on the next patrol; they are easier to recover while still dry.',
  'Paper Drink Carton':
    'Treat drink cartons as a separate recyclable stream at the next collection if they keep appearing at the same camera.',
  'Glass Bottle':
    'Handle glass bottles on a dedicated pickup so fragments are not left on the sand.',
  'Face Mask':
    'Bag masks separately during the next inspection; do not mix them with general recyclables.',
};

function recommendationFor(top, grand, comparison) {
  if (!top) {
    return 'Continue scheduled monitoring at Paco Beach and review camera views if waste is visible but not recorded.';
  }
  const specific = CLASS_ACTIONS[top] || `Focus the next inspection on recorded ${top} at Paco Beach.`;
  const volume =
    grand >= 20
      ? ' Recorded counts for this period are high enough to schedule a collection pass.'
      : ' Keep daily monitoring and collect when the same class appears again at the same camera.';
  let trend = '';
  if (comparison?.direction === 'up' && comparison.percent != null) {
    trend = ` Counts rose ${comparison.percent}% versus the previous equivalent period, so treat this as an increase to watch, not proof that one action will clear the shoreline.`;
  } else if (comparison?.direction === 'down' && comparison.percent != null) {
    trend = ` Counts fell ${comparison.percent}% versus the previous equivalent period; keep the same inspection points until the decline holds.`;
  }
  return `${specific}${volume}${trend}`;
}

export function buildMonitoringNotes(detections, options = {}) {
  const list = (detections || []).filter((d) => datasetClassOf(d));
  const totals = classCounts(list);
  const ranked = namesInOrder(datasetClasses(), totals, { onlyPositiveExtras: true })
    .filter((name) => totals[name] > 0)
    .sort((a, b) => totals[b] - totals[a]);
  const grand = ranked.reduce((sum, name) => sum + totals[name], 0);
  const avg = avgConfidence(list);
  const periodLabel = options.periodLabel || 'the selected monitoring period';
  const comparison = options.comparison || null;

  if (!list.length || grand === 0) {
    return {
      observation: `No recorded waste detections for ${periodLabel} at Paco Beach, Barangay Gracia. Charts and exports for this view are empty because no matching database records were found.`,
      recommendation:
        'Continue scheduled coastal monitoring. If waste is visible on the live cameras, review detection settings and confirm the cameras are recording before assuming the shoreline is clear.',
    };
  }

  const categories = categoryCounts(list);
  const top = ranked[0];
  const topShare = grand > 0 ? Math.round((totals[top] / grand) * 100) : 0;
  const cameras = [...new Set(list.map((d) => d.camera_id).filter(Boolean))];
  const cameraText = cameras.length ? cameras.join(', ') : 'the configured cameras';
  const notVisible = list.filter((d) => d.status === 'No Longer Visible' || d.status === 'Confirmed Cleaned').length;
  const verified = list.filter((d) => d.status === 'Cleaning Verified').length;
  const trendText =
    comparison?.direction === 'up' && comparison.percent != null
      ? `That is ${comparison.percent}% more than the previous equivalent period (${comparison.previous} recorded).`
      : comparison?.direction === 'down' && comparison.percent != null
        ? `That is ${comparison.percent}% fewer than the previous equivalent period (${comparison.previous} recorded).`
        : comparison?.label === 'No previous records to compare'
          ? 'There were no matching records in the previous equivalent period, so a percentage change is not shown.'
          : comparison?.direction === 'same'
            ? 'The count is unchanged versus the previous equivalent period.'
            : '';

  const observation = [
    `For ${periodLabel}, ${list.length} recorded detection${list.length === 1 ? '' : 's'} (${grand} item${grand === 1 ? '' : 's'}) were logged at Paco Beach from ${cameraText}.`,
    top ? `${top} was the most frequent classification (${totals[top]} records, ${topShare}% of this view).` : '',
    namesInOrder(PARENT_CATEGORIES, categories, { onlyPositiveExtras: true })
      .filter((name) => categories[name] > 0)
      .map((name) => `${name} ${categories[name]}`)
      .join(', ')
      ? `Categories in this view: ${namesInOrder(PARENT_CATEGORIES, categories, { onlyPositiveExtras: true })
          .filter((name) => categories[name] > 0)
          .map((name) => `${name} ${categories[name]}`)
          .join(', ')}.`
      : '',
    avg != null
      ? `Mean detector confidence on these records was ${avg}% (score of the saved detection, not model accuracy).`
      : '',
    trendText,
    notVisible
      ? `${notVisible} record${notVisible === 1 ? '' : 's'} ${notVisible === 1 ? 'is' : 'are'} marked No Longer Visible because the object left the camera view — that is inferred disappearance, not verified physical cleaning.`
      : '',
    verified
      ? `${verified} record${verified === 1 ? '' : 's'} ${verified === 1 ? 'has' : 'have'} Cleaning Verified, confirmed on site by the Barangay Sanitary Inspector or an authorized administrator.`
      : 'No record has Cleaning Verified in this period; physical cleaning has not been confirmed by an inspector.',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    observation,
    recommendation: recommendationFor(top, grand, comparison),
  };
}

export function buildDailyNotes(detections) {
  const groups = {};
  (detections || []).forEach((d) => {
    const key = detectionDateKey(d);
    if (!key || key === '—') return;
    if (!groups[key]) groups[key] = [];
    groups[key].push(d);
  });
  return Object.keys(groups)
    .sort()
    .reverse()
    .map((date) => {
      const notes = buildMonitoringNotes(groups[date]);
      const count = groups[date].reduce((s, d) => s + qty(d), 0);
      return { date, count, ...notes };
    });
}

function durationLabel(detections) {
  const times = (detections || [])
    .map((d) => {
      const iso = d.detected_at_iso;
      const t = iso ? new Date(iso) : new Date(String(d.detected_at || '').replace(' ', 'T'));
      return t.getTime();
    })
    .filter((n) => !Number.isNaN(n));
  if (times.length < 2) return '—';
  const ms = Math.max(...times) - Math.min(...times);
  const hours = Math.max(1, Math.round(ms / 36e5));
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export function nextReportNumber() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const t = String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  return `CWMR-${y}${m}${day}-${t}`;
}

const REPORT_CSS = `
  /* Margin 0 leaves no room for the browser's own header/footer (about:blank, 1/1); the 8 mm is padding instead. */
  @page { size: 8.5in 13in; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 11px; margin: 0; padding: 8mm; background: #fff; }
  .page { width: 190mm; margin: 0 auto; border: 1.5px solid #000; }
  .page + .page { page-break-before: always; }
  table { width: 100%; border-collapse: collapse; }
  td, th { border: 1px solid #000; padding: 2.5px 8px; vertical-align: middle; }
  .bar { text-align: center; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; }
  .head { text-align: center; padding: 6px 10px 6px; }
  .head img { width: 62px; height: 62px; object-fit: contain; display: block; margin: 0 auto 4px; }
  .loc { font-size: 12px; font-weight: 700; }
  .sys { font-size: 11px; margin-top: 2px; }
  .meta { width: 100%; border-collapse: collapse; }
  .meta td { border: none; padding: 2px 8px 6px; }
  .meta .left { text-align: left; font-weight: 700; }
  .meta .right { text-align: right; font-weight: 700; }
  .bar-green { background: #6aa84f; color: #000; font-size: 12px; padding: 5px 8px; }
  .bar-blue { background: #6fa8dc; color: #000; font-size: 12px; padding: 5px 8px; }
  .bar-gray { background: #cccccc; color: #000; font-size: 12px; padding: 5px 8px; }
  .bar-rose { background: #dd7e6b; color: #000; font-size: 12px; padding: 5px 8px; }
  .bar-royal { background: #6d9eeb; color: #000; font-size: 12px; padding: 5px 8px; }
  .sub { text-align: center; font-size: 11px; }
  .sub-gray { background: #d9d9d9; }
  .lbl { font-weight: 700; width: 22%; }
  .val { text-align: center; }
  .yh th { background: #ffd966; font-size: 10px; text-transform: uppercase; text-align: center; }
  .num { text-align: center; font-weight: 600; }
  .empty { height: 22px; }
  .note { font-size: 9px; font-style: italic; color: #333; padding: 6px 8px; border: none; }
  .obs { padding: 4px 8px; font-size: 11px; line-height: 1.3; }
  .hint { display: block; margin-top: 18px; font-size: 9px; font-style: italic; color: #555; }
  .foot { font-size: 8.5px; font-style: italic; padding: 6px 10px 6px; line-height: 1.35; }
  @media print { .page { border: 1.5px solid #000; margin: 0; width: auto; } }
`;

/**
 * The same numbers as the official form (buildOfficialReportHtml), as plain
 * data for the digital form on the Main Dashboard.
 */
export function buildReportData({
  generatedBy = 'Administrator',
  cameras,
  monitoringPeriod,
  remarks,
  recommendations,
  stats = {},
  composition = [],
  detections = [],
}) {
  const now = new Date();
  const list = (detections || []).filter((d) => datasetClassOf(d));
  const avg = avgConfidence(detections);
  const totals = classCounts(list);
  (composition || []).forEach((c) => {
    const key = datasetClassOf({ class: c.label });
    if (!key || !datasetClasses().includes(key) || totals[key]) return;
    if (c.count) totals[key] = Number(c.count) || 0;
  });
  const categoryTotals = categoryCounts(list);
  const grand = Object.values(categoryTotals).reduce((s, n) => s + (n || 0), 0);
  const period = monitoringPeriod
    || now.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
  const auto = buildMonitoringNotes(list, { periodLabel: period });

  const examples = {};
  PARENT_CATEGORIES.forEach((category) => {
    examples[category] = datasetClasses().filter((name) => CATEGORY_BY_CLASS[name] === category);
  });
  list.forEach((d) => {
    const category = parentCategoryOf(d);
    const name = datasetClassOf(d);
    if (!category || !name) return;
    const row = examples[category] || (examples[category] = []);
    if (!row.some((item) => item.toLowerCase() === name.toLowerCase())) row.push(name);
  });

  const categories = namesInOrder(PARENT_CATEGORIES, categoryTotals, { onlyPositiveExtras: true });
  const byDate = {};
  list.forEach((d) => {
    const key = detectionDateKey(d);
    const category = parentCategoryOf(d);
    if (!key || !category) return;
    if (!byDate[key]) byDate[key] = categoryCounts([]);
    byDate[key][category] = (byDate[key][category] || 0) + qty(d);
  });
  const dates = Object.keys(byDate).sort().reverse().map((date) => ({
    date,
    counts: byDate[date],
    total: categories.reduce((s, c) => s + (byDate[date][c] || 0), 0),
  }));

  return {
    info: {
      cameras: cameraList(detections, cameras),
      location: 'Paco Beach, Barangay Gracia',
      period,
      generatedAt: now.toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short' }),
      generatedBy: generatedBy || 'Administrator',
      averageConfidence: avg != null ? `${avg}%` : '—',
      duration: durationLabel(detections),
    },
    summary: categories.map((category) => ({
      category,
      classifications: examples[category] || [],
      total: categoryTotals[category] || 0,
    })),
    grandTotal: grand,
    classes: namesInOrder(datasetClasses(), totals, { onlyPositiveExtras: true }).map((name) => ({
      name,
      category: CATEGORY_BY_CLASS[name]
        || list.map((d) => (datasetClassOf(d) === name ? parentCategoryOf(d) : '')).find(Boolean)
        || '',
      count: totals[name] || 0,
    })),
    statistics: {
      records: grand,
      events: list.length,
      notVisible: list.filter((d) => d.status === 'No Longer Visible' || d.status === 'Confirmed Cleaned').length,
      verified: list.filter((d) => d.status === 'Cleaning Verified').length,
      today: Number(stats.detections ?? 0),
      allTime: Number(stats.total_detections ?? grand),
    },
    categories,
    dates,
    observations: remarks || auto.observation,
    recommendations: recommendations || auto.recommendation,
  };
}

export function buildOfficialReportHtml({
  reportNumber,
  generatedBy = 'Barangay Sanitary Inspector',
  cameras,
  monitoringPeriod,
  remarks,
  recommendations,
  stats = {},
  composition = [],
  detections = [],
}) {
  const now = new Date();
  const generatedAt = now.toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short' });
  const period =
    monitoringPeriod ||
    now.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
  const avg = avgConfidence(detections);
  const avgLabel = avg != null ? `${avg}%` : '—';
  const cams = cameraList(detections, cameras);
  const duration = durationLabel(detections);
  const list = (detections || []).filter((d) => datasetClassOf(d));
  const events = list.length;
  const totals = classCounts(list);
  (composition || []).forEach((c) => {
    const key = datasetClassOf({ class: c.label });
    // Only real waste classes; category totals like "Plastic" are not rows here.
    if (!key || !datasetClasses().includes(key) || totals[key]) return;
    if (c.count) totals[key] = Number(c.count) || 0;
  });
  const grand = Object.values(categoryCounts(list)).reduce((s, name) => s + (name || 0), 0);
  const notVisibleCount = list.filter((d) => d.status === 'No Longer Visible' || d.status === 'Confirmed Cleaned').length;
  const verifiedCount = list.filter((d) => d.status === 'Cleaning Verified').length;
  const today = Number(stats.detections ?? 0);
  const allTime = Number(stats.total_detections ?? grand);

  const auto = buildMonitoringNotes(list, { periodLabel: period });
  const rec = recommendations || auto.recommendation;
  const remarkText = remarks || auto.observation;
  const logoUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/brgy-gracia-seal.jpg`
      : '/brgy-gracia-seal.jpg';

  const categoryTotals = categoryCounts(list);
  const categoryExamples = {};
  list.forEach((detection) => {
    const category = parentCategoryOf(detection);
    const name = datasetClassOf(detection);
    if (!category || !name) return;
    const current = categoryExamples[category] || [];
    if (!current.some((item) => item.toLowerCase() === name.toLowerCase())) current.push(name);
    categoryExamples[category] = current;
  });
  PARENT_CATEGORIES.forEach((category) => {
    const official = datasetClasses().filter((name) => CATEGORY_BY_CLASS[name] === category);
    const extra = categoryExamples[category] || [];
    extra.forEach((name) => {
      if (!official.some((item) => item.toLowerCase() === name.toLowerCase())) official.push(name);
    });
    categoryExamples[category] = official;
  });
  const summaryRows = namesInOrder(PARENT_CATEGORIES, categoryTotals, { onlyPositiveExtras: true }).map(
    (category) =>
      `<tr><td>${esc(category)}</td><td colspan="3">${esc((categoryExamples[category] || []).join(', '))}</td><td colspan="2" class="num">${categoryTotals[category] || 0}</td></tr>`,
  ).join('');
  const classRows = namesInOrder(datasetClasses(), totals, { onlyPositiveExtras: true }).map((name) => {
    const category = CATEGORY_BY_CLASS[name]
      || list.map((detection) => (datasetClassOf(detection) === name ? parentCategoryOf(detection) : '')).find(Boolean)
      || '';
    return `<tr><td colspan="3">${esc(name)}</td><td>${esc(category)}</td><td colspan="2" class="num">${totals[name] || 0}</td></tr>`;
  }).join('');

  // The form is 6 columns wide. Up to 4 categories fit as columns (new ones show
  // even at 0); with more, only categories that have records in this report.
  const DATE_CATEGORIES = PARENT_CATEGORIES.length <= 4
    ? [...PARENT_CATEGORIES]
    : PARENT_CATEGORIES.filter((category) => (categoryTotals[category] || 0) > 0).slice(0, 4);
  const DATE_SPAN = Math.max(1, 6 - DATE_CATEGORIES.length - 1);
  const byDate = {};
  list.forEach((d) => {
    const key = detectionDateKey(d);
    const category = parentCategoryOf(d);
    if (!category || !DATE_CATEGORIES.includes(category)) return;
    if (!byDate[key]) byDate[key] = categoryCounts([]);
    byDate[key][category] += qty(d);
  });
  const allDateKeys = Object.keys(byDate).filter(Boolean).sort();
  // Up to 3 date rows fit: all dates when there are 3 or fewer, otherwise the
  // 2 latest plus one "Earlier" row (so TOTAL still covers every date).
  const shown = allDateKeys.length <= DATE_ROW_COUNT ? allDateKeys.length : DATE_ROW_COUNT - 1;
  const dateKeys = allDateKeys.slice(allDateKeys.length - shown);
  const earlierKeys = allDateKeys.slice(0, allDateKeys.length - shown);
  if (earlierKeys.length) {
    const label = `Earlier (${earlierKeys.length} day${earlierKeys.length === 1 ? '' : 's'})`;
    byDate[label] = categoryCounts([]);
    earlierKeys.forEach((key) => {
      DATE_CATEGORIES.forEach((category) => { byDate[label][category] += byDate[key][category] || 0; });
    });
    dateKeys.unshift(label);
  }
  const dateTotals = categoryCounts([]);
  const dateRows = dateKeys
    .map((key) => {
      const row = byDate[key];
      const empty = !key || !row;
      if (!empty) DATE_CATEGORIES.forEach((category) => { dateTotals[category] += row[category] || 0; });
      const total = empty ? 0 : DATE_CATEGORIES.reduce((s, category) => s + (row[category] || 0), 0);
      return `<tr>
        <td colspan="${DATE_SPAN}">${esc(key || '')}</td>
        ${DATE_CATEGORIES.map((category) => `<td class="num">${empty ? '' : row[category] || 0}</td>`).join('')}
        <td class="num">${empty ? '' : total}</td>
      </tr>`;
    })
    .join('');
  const dateGrand = DATE_CATEGORIES.reduce((s, category) => s + dateTotals[category], 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(reportNumber)} — Coastal Waste Monitoring Report</title>
  <style>${REPORT_CSS}</style>
</head>
<body>
  <div class="page">
    <div class="head">
      <img src="${esc(logoUrl)}" alt="Barangay Gracia seal" />
      <div class="loc">Barangay Gracia • Paco Beach • Tagoloan, Misamis Oriental</div>
      <div class="sys">Computer Vision-Based Coastal Waste Monitoring and Reporting System</div>
    </div>
    <table class="meta">
      <tr>
        <td class="left">Generated Monitoring Report</td>
        <td class="right">Report No. : ${esc(reportNumber)}</td>
      </tr>
    </table>
    <table>
      <tr><td colspan="6" class="bar bar-green">MONITORING INFORMATION</td></tr>
      <tr>
        <td class="lbl">Camera ID</td><td class="val" colspan="2">${esc(cams)}</td>
        <td class="lbl">Monitoring Location</td><td class="val" colspan="2">Paco Beach, Barangay Gracia</td>
      </tr>
      <tr>
        <td class="lbl">Monitoring Period</td><td class="val" colspan="2">${esc(period)}</td>
        <td class="lbl">Date Generated</td><td class="val" colspan="2">${esc(generatedAt)}</td>
      </tr>
      <tr>
        <td class="lbl">Generated By</td><td class="val" colspan="2">${esc(generatedBy || 'Barangay Sanitary Inspector')}</td>
        <td class="lbl">Report ID</td><td class="val" colspan="2">${esc(reportNumber)}</td>
      </tr>
      <tr>
        <td class="lbl">Average Confidence</td><td class="val" colspan="2">${esc(avgLabel)}</td>
        <td class="lbl">Monitoring Duration</td><td class="val" colspan="2">${esc(duration)}</td>
      </tr>
      <tr><td colspan="6" class="bar bar-blue">WASTE DETECTION SUMMARY</td></tr>
      <tr class="yh"><th>Waste category</th><th colspan="3">Classifications</th><th colspan="2">Total detections</th></tr>
      ${summaryRows}
      <tr><td colspan="4"><b>GRAND TOTAL</b></td><td colspan="2" class="num"><b>${grand}</b></td></tr>
      <tr class="yh"><th colspan="3">Waste classification</th><th>Category</th><th colspan="2">Count</th></tr>
      ${classRows}
      <tr><td colspan="6" class="bar bar-rose">DETECTION STATISTICS</td></tr>
      <tr class="yh"><th>Description</th><th colspan="2">Value</th><th>Description</th><th colspan="2">Value</th></tr>
      <tr>
        <td class="lbl">Records in this report</td><td class="val" colspan="2">${esc(grand)}</td>
        <td class="lbl">Average Confidence</td><td class="val" colspan="2">${esc(avgLabel)}</td>
      </tr>
      <tr>
        <td class="lbl">Today's Detections (database)</td><td class="val" colspan="2">${esc(today)}</td>
        <td class="lbl">Detection Events</td><td class="val" colspan="2">${esc(events)}</td>
      </tr>
      <tr>
        <td class="lbl">All-time Detections (database)</td><td class="val" colspan="2">${esc(allTime || '—')}</td>
        <td class="lbl">Monitoring Location</td><td class="val" colspan="2">Paco Beach, Barangay Gracia</td>
      </tr>
      <tr>
        <td class="lbl">No Longer Visible (inferred)</td><td class="val" colspan="2">${esc(notVisibleCount)}</td>
        <td class="lbl">Cleaning Verified</td><td class="val" colspan="2">${esc(verifiedCount)}</td>
      </tr>
      <tr><td colspan="6" class="bar bar-green">DETECTION SUMMARY BY DATE</td></tr>
      <tr class="yh">
        <th colspan="${DATE_SPAN}">Date</th>${DATE_CATEGORIES.map((category) => `<th>${esc(category)}</th>`).join('')}<th>Total</th>
      </tr>
      ${dateRows || '<tr><td colspan="6" class="val">No dated records in this report.</td></tr>'}
      <tr>
        <td colspan="${DATE_SPAN}"><b>TOTAL</b></td>
        ${DATE_CATEGORIES.map((category) => `<td class="num"><b>${dateTotals[category]}</b></td>`).join('')}
        <td class="num"><b>${dateGrand}</b></td>
      </tr>
      <tr><td colspan="6" class="bar bar-gray">OBSERVATIONS</td></tr>
      <tr><td colspan="6" class="obs">${esc(remarkText)}</td></tr>
      <tr><td colspan="6" class="bar bar-royal">RECOMMENDATIONS</td></tr>
      <tr><td colspan="6" class="obs">${esc(rec)}</td></tr>
    </table>
    <div class="foot">${esc(REPORT_FOOTER)}</div>
  </div>
</body>
</html>`;
}

/** Opens the print dialog from inside the report window, so the dashboard is never held up. */
const SELF_PRINT = '<script>window.addEventListener("load",function(){setTimeout(function(){window.focus();window.print();},150);});</script>';

export function printOfficialReport(html) {
  const page = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${SELF_PRINT}</body>`) : html + SELF_PRINT;
  const blob = new Blob([page], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank', 'width=920,height=720');
  if (!w) {
    URL.revokeObjectURL(url);
    return false;
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

export async function saveAndPrintReport(payload, html) {
  const opened = printOfficialReport(html);
  if (!opened) {
    throw new Error('The browser blocked the report window. Allow pop-ups for this site, then try again.');
  }
  // Record the report in the background; the PDF window does not wait for the server.
  createReport(payload).catch(() => null);
  return true;
}
