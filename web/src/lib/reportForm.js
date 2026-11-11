import { CATEGORY_BY_CLASS, PARENT_CATEGORIES, WASTE_CLASSES } from '../constants';
import { createReport } from '../api/reports';

const DATASET_CLASSES = WASTE_CLASSES;
const DATE_ROW_COUNT = 31;

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
  const raw = String(det?.dataset_class || det?.class || '').trim();
  return DATASET_CLASSES.find((name) => name.toLowerCase() === raw.toLowerCase()) || '';
}

export function parentCategoryOf(det) {
  const name = datasetClassOf(det);
  if (name && CATEGORY_BY_CLASS[name]) return CATEGORY_BY_CLASS[name];
  const parent = String(det?.parent_category || '').trim();
  return PARENT_CATEGORIES.includes(parent) ? parent : '';
}

function categoryCounts(detections) {
  const counts = Object.fromEntries(PARENT_CATEGORIES.map((name) => [name, 0]));
  (detections || []).forEach((d) => {
    const name = parentCategoryOf(d);
    if (!name) return;
    counts[name] += qty(d);
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

function cameraList(detections) {
  const ids = [...new Set((detections || []).map((d) => d.camera_id).filter(Boolean))];
  return ids.length ? ids.join(', ') : 'CAM-01';
}

function classCounts(detections) {
  const counts = Object.fromEntries(DATASET_CLASSES.map((name) => [name, 0]));
  (detections || []).forEach((d) => {
    const name = datasetClassOf(d);
    if (!name) return;
    counts[name] += qty(d);
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
  const ranked = DATASET_CLASSES.filter((name) => totals[name] > 0).sort(
    (a, b) => totals[b] - totals[a],
  );
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
  const cleaned = list.filter((d) => d.status === 'Confirmed Cleaned').length;
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
    PARENT_CATEGORIES.filter((name) => categories[name] > 0)
      .map((name) => `${name} ${categories[name]}`)
      .join(', ')
      ? `Parent categories in this view: ${PARENT_CATEGORIES.filter((name) => categories[name] > 0)
          .map((name) => `${name} ${categories[name]}`)
          .join(', ')}.`
      : '',
    avg != null
      ? `Mean detector confidence on these records was ${avg}% (score of the saved detection, not model accuracy).`
      : '',
    trendText,
    cleaned
      ? `${cleaned} record${cleaned === 1 ? '' : 's'} ${cleaned === 1 ? 'is' : 'are'} marked Confirmed Cleaned because the object left the camera view — that is inferred disappearance, not verified physical cleaning.`
      : '',
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
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 11px; margin: 0; background: #fff; }
  .page { width: 190mm; margin: 0 auto 12mm; border: 1.5px solid #000; }
  .page + .page { page-break-before: always; }
  table { width: 100%; border-collapse: collapse; }
  td, th { border: 1px solid #000; padding: 6px 8px; vertical-align: middle; }
  .bar { text-align: center; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; }
  .head { text-align: center; padding: 8px 10px 10px; }
  .head img { width: 72px; height: 72px; object-fit: contain; display: block; margin: 0 auto 6px; }
  .loc { font-size: 12px; font-weight: 700; }
  .sys { font-size: 11px; margin-top: 2px; }
  .meta { width: 100%; border-collapse: collapse; }
  .meta td { border: none; padding: 2px 8px 8px; }
  .meta .left { text-align: left; font-weight: 700; }
  .meta .right { text-align: right; font-weight: 700; }
  .bar-green { background: #6aa84f; color: #000; font-size: 12px; padding: 7px 8px; }
  .bar-blue { background: #6fa8dc; color: #000; font-size: 12px; padding: 7px 8px; }
  .bar-gray { background: #cccccc; color: #000; font-size: 12px; padding: 7px 8px; }
  .bar-rose { background: #dd7e6b; color: #000; font-size: 12px; padding: 7px 8px; }
  .bar-royal { background: #6d9eeb; color: #000; font-size: 12px; padding: 7px 8px; }
  .sub { text-align: center; font-size: 11px; }
  .sub-gray { background: #d9d9d9; }
  .lbl { font-weight: 700; width: 22%; }
  .val { text-align: center; }
  .yh th { background: #ffd966; font-size: 10px; text-transform: uppercase; text-align: center; }
  .num { text-align: center; font-weight: 600; }
  .empty { height: 22px; }
  .note { font-size: 9px; font-style: italic; color: #333; padding: 6px 8px; border: none; }
  .obs { min-height: 72px; padding: 8px; font-size: 11px; line-height: 1.45; }
  .hint { display: block; margin-top: 18px; font-size: 9px; font-style: italic; color: #555; }
  .foot { font-size: 8.5px; font-style: italic; padding: 8px 10px 10px; line-height: 1.4; }
  @media print { .page { border: 1.5px solid #000; margin: 0; width: auto; } }
`;

export function buildOfficialReportHtml({
  reportNumber,
  generatedBy = 'Barangay Sanitary Inspector',
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
  const cams = cameraList(detections);
  const duration = durationLabel(detections);
  const list = (detections || []).filter((d) => datasetClassOf(d));
  const events = list.length;
  const totals = classCounts(list);
  (composition || []).forEach((c) => {
    const key = datasetClassOf({ class: c.label });
    if (!key || totals[key]) return;
    if (c.count) totals[key] = Number(c.count) || 0;
  });
  const grand = PARENT_CATEGORIES.reduce((s, name) => s + (categoryCounts(list)[name] || 0), 0);
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
  const categoryExamples = Object.fromEntries(
    PARENT_CATEGORIES.map((category) => [
      category,
      DATASET_CLASSES.filter((name) => CATEGORY_BY_CLASS[name] === category).join(', '),
    ]),
  );
  const summaryRows = PARENT_CATEGORIES.map(
    (category) =>
      `<tr><td>${esc(category)}</td><td colspan="3">${esc(categoryExamples[category])}</td><td colspan="2" class="num">${categoryTotals[category] || 0}</td></tr>`,
  ).join('');
  const classRows = DATASET_CLASSES.map((name) => {
    const category = CATEGORY_BY_CLASS[name];
    return `<tr><td colspan="3">${esc(name)}</td><td>${esc(category)}</td><td colspan="2" class="num">${totals[name] || 0}</td></tr>`;
  }).join('');

  const byDate = {};
  list.forEach((d) => {
    const key = detectionDateKey(d);
    const category = parentCategoryOf(d);
    if (!category) return;
    if (!byDate[key]) byDate[key] = categoryCounts([]);
    byDate[key][category] += qty(d);
  });
  const dateKeys = Object.keys(byDate).filter(Boolean).sort().slice(-DATE_ROW_COUNT);
  const dateTotals = categoryCounts([]);
  const dateRows = dateKeys
    .map((key) => {
      const row = byDate[key];
      const empty = !key || !row;
      if (!empty) PARENT_CATEGORIES.forEach((category) => { dateTotals[category] += row[category] || 0; });
      const total = empty ? 0 : PARENT_CATEGORIES.reduce((s, category) => s + (row[category] || 0), 0);
      return `<tr>
        <td>${esc(key || '')}</td>
        ${PARENT_CATEGORIES.map((category) => `<td class="num">${empty ? '' : row[category] || 0}</td>`).join('')}
        <td class="num">${empty ? '' : total}</td>
      </tr>`;
    })
    .join('');
  const dateGrand = PARENT_CATEGORIES.reduce((s, category) => s + dateTotals[category], 0);

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
        <td class="lbl">Monitoring Duration</td><td class="val" colspan="2">${esc(duration)}</td>
        <td class="lbl">Camera Used</td><td class="val" colspan="2">${esc(cams)}</td>
      </tr>
      <tr><td colspan="6" class="bar bar-green">DETECTION SUMMARY BY DATE</td></tr>
      <tr class="yh">
        <th>Date</th><th>Plastic</th><th>Paper</th><th>Metal</th><th>Glass</th><th>Total</th>
      </tr>
      ${dateRows || '<tr><td colspan="6" class="val">No dated records in this report.</td></tr>'}
      <tr>
        <td><b>TOTAL</b></td>
        ${PARENT_CATEGORIES.map((category) => `<td class="num"><b>${dateTotals[category]}</b></td>`).join('')}
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

export function printOfficialReport(html) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank', 'width=920,height=720');
  if (!w) {
    URL.revokeObjectURL(url);
    return false;
  }
  let printed = false;
  const printWhenReady = () => {
    if (printed) return;
    printed = true;
    try {
      w.focus();
      w.print();
    } catch {
      /* user can File → Print in the report window */
    }
  };
  w.onload = printWhenReady;
  setTimeout(printWhenReady, 400);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

export async function saveAndPrintReport(payload, html) {
  printOfficialReport(html);
  try {
    return await createReport(payload);
  } catch {
    return null;
  }
}
