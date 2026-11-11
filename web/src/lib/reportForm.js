import { classifyWaste } from './wasteFilters';
import { createReport } from '../api/reports';

const CATEGORY_EXAMPLES = {
  Plastic: 'Plastic bottles, plastic bags, sachets, fishing nets, styrofoam, plastic cups',
  Paper: 'Cardboard, newspapers, paper packaging',
  Metal: 'Tin cans, aluminum cans, scrap metal',
  Wood: 'Driftwood, wooden debris, palettes',
  Glass: 'Glass bottles, glass fragments',
};

const SUMMARY_CATEGORIES = ['Plastic', 'Paper', 'Metal', 'Wood', 'Glass'];

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function confidencePct(d) {
  if (d?.confidence == null) return '—';
  const n = Number(d.confidence);
  if (Number.isNaN(n)) return '—';
  const pct = n <= 1 ? n * 100 : n;
  return `${Math.round(pct)}%`;
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

function categoryBucket(det) {
  const { category } = classifyWaste(det);
  const c = String(category || '').toLowerCase();
  if (c.includes('plastic')) return 'Plastic';
  if (c.includes('paper')) return 'Paper';
  if (c.includes('metal')) return 'Metal';
  if (c.includes('wood')) return 'Wood';
  if (c.includes('glass')) return 'Glass';
  return 'Plastic';
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
  .bar-green { background: #6aa84f; color: #000; font-size: 13px; padding: 10px 8px; }
  .bar-dgreen { background: #38761d; color: #fff; font-size: 12px; padding: 7px 8px; }
  .bar-blue { background: #6fa8dc; color: #000; font-size: 12px; padding: 7px 8px; }
  .bar-red { background: #e06666; color: #000; font-size: 12px; padding: 7px 8px; }
  .bar-olive { background: #93c47d; color: #000; font-size: 12px; padding: 7px 8px; }
  .bar-gray { background: #cccccc; color: #000; font-size: 12px; padding: 7px 8px; }
  .bar-royal { background: #3d85c6; color: #fff; font-size: 12px; padding: 7px 8px; }
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
  .signs { width: 100%; border-collapse: collapse; margin-top: 8px; }
  .signs td { border: none; text-align: center; padding: 18px 16px 8px; width: 50%; }
  .signs .ln { border-top: 1px solid #000; margin: 28px 18px 4px; padding-top: 4px; font-size: 10px; }
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
  quota = null,
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
  const list = detections || [];
  const events = list.length;
  const totals = { Plastic: 0, Paper: 0, Metal: 0, Wood: 0, Glass: 0 };
  list.forEach((d) => {
    totals[categoryBucket(d)] += qty(d);
  });
  (composition || []).forEach((c) => {
    const key = categoryBucket({ waste_category: c.label, class: c.label });
    if (!totals[key] && c.count) totals[key] = Number(c.count) || 0;
  });
  const grand = SUMMARY_CATEGORIES.reduce((s, k) => s + (totals[k] || 0), 0);
  const today = Number(stats.detections ?? 0);
  const allTime = Number(stats.total_detections ?? grand);

  const rec =
    recommendations ||
    (quota?.status === 'reached'
      ? quota.cleanup_recommendation
      : '');
  const remarkText = remarks || '';

  const summaryRows = SUMMARY_CATEGORIES.map(
    (k) =>
      `<tr><td>${k}</td><td>${esc(CATEGORY_EXAMPLES[k])}</td><td class="num">${totals[k] || 0}</td></tr>`,
  ).join('');

  const byDate = {};
  list.forEach((d) => {
    const key = detectionDateKey(d);
    if (!byDate[key]) byDate[key] = { Plastic: 0, Paper: 0, Metal: 0, Wood: 0, Glass: 0 };
    byDate[key][categoryBucket(d)] += qty(d);
  });
  const dateKeys = Object.keys(byDate).sort();
  while (dateKeys.length < 8) dateKeys.push('');
  const dateTotals = { Plastic: 0, Paper: 0, Metal: 0, Wood: 0, Glass: 0 };
  const dateRows = dateKeys
    .map((key) => {
      const row = byDate[key] || { Plastic: 0, Paper: 0, Metal: 0, Wood: 0, Glass: 0 };
      if (key) SUMMARY_CATEGORIES.forEach((c) => { dateTotals[c] += row[c]; });
      const total = SUMMARY_CATEGORIES.reduce((s, c) => s + (row[c] || 0), 0);
      const empty = !key;
      return `<tr>
        <td>${esc(key || '')}</td>
        ${SUMMARY_CATEGORIES.map((c) => `<td class="num">${empty ? '' : row[c] || 0}</td>`).join('')}
        <td class="num">${empty ? '' : total}</td>
      </tr>`;
    })
    .join('');
  const dateGrand = SUMMARY_CATEGORIES.reduce((s, c) => s + dateTotals[c], 0);

  let detRows = list.map((d) => {
    const { category, subtype } = classifyWaste(d);
    return `<tr>
      <td class="num">${esc(d.id ?? '')}</td>
      <td>${esc(d.detected_at || '—')}</td>
      <td>${esc(category)}</td>
      <td>${esc(subtype)}</td>
      <td class="num">${esc(confidencePct(d))}</td>
      <td class="num">${esc(qty(d))}</td>
      <td class="num">${esc(d.camera_id || 'CAM-01')}</td>
    </tr>`;
  }).join('');
  const minRows = 10;
  const extra = Math.max(0, minRows - list.length);
  detRows += Array.from({ length: extra }, () =>
    `<tr>${'<td class="empty"></td>'.repeat(7)}</tr>`,
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(reportNumber)} — Coastal Waste Monitoring Report</title>
  <style>${REPORT_CSS}</style>
</head>
<body>
  <div class="page">
    <table>
      <tr><td colspan="4" class="bar bar-green">COMPUTER VISION-BASED COASTAL WASTE MONITORING REPORT</td></tr>
      <tr><td colspan="4" class="sub">Computer Vision-Based Coastal Waste Monitoring and Reporting System</td></tr>
      <tr><td colspan="4" class="sub">Barangay Gracia • Paco Beach • Tagoloan, Misamis Oriental</td></tr>
      <tr>
        <td colspan="2" class="sub">Generated Monitoring Report</td>
        <td colspan="2" class="sub">Report No. : ${esc(reportNumber)}</td>
      </tr>
      <tr><td colspan="4" class="bar bar-dgreen">MONITORING INFORMATION</td></tr>
      <tr>
        <td class="lbl">Camera ID</td><td class="val">${esc(cams)}</td>
        <td class="lbl">Monitoring Location</td><td class="val">Paco Beach, Barangay Gracia</td>
      </tr>
      <tr>
        <td class="lbl">Monitoring Period</td><td class="val">${esc(period)}</td>
        <td class="lbl">Date Generated</td><td class="val">${esc(generatedAt)}</td>
      </tr>
      <tr>
        <td class="lbl">Generated By</td><td class="val">${esc(generatedBy || 'Barangay Sanitary Inspector')}</td>
        <td class="lbl">Report ID</td><td class="val">${esc(reportNumber)}</td>
      </tr>
      <tr>
        <td class="lbl">Average Confidence</td><td class="val">${esc(avgLabel)}</td>
        <td class="lbl">Monitoring Duration</td><td class="val">${esc(duration)}</td>
      </tr>
    </table>
    <table>
      <tr><td colspan="3" class="bar bar-blue">WASTE DETECTION SUMMARY</td></tr>
      <tr class="yh"><th>Waste Category</th><th>Common Examples</th><th>Total Detections</th></tr>
      ${summaryRows}
      <tr><td colspan="2"><b>GRAND TOTAL</b></td><td class="num"><b>${grand}</b></td></tr>
    </table>
    <table>
      <tr><td colspan="4" class="bar bar-red">DETECTION STATISTICS</td></tr>
      <tr>
        <td class="lbl">Total Detections</td><td class="val">${esc(allTime || grand)}</td>
        <td class="lbl">Average Confidence</td><td class="val">${esc(avgLabel)}</td>
      </tr>
      <tr>
        <td class="lbl">Today's Detections</td><td class="val">${esc(today)}</td>
        <td class="lbl">Detection Events</td><td class="val">${esc(events)}</td>
      </tr>
      <tr>
        <td class="lbl">Monitoring Duration</td><td class="val">${esc(duration)}</td>
        <td class="lbl">Camera Used</td><td class="val">${esc(cams)}</td>
      </tr>
    </table>
    <table>
      <tr><td colspan="7" class="bar bar-olive">DETECTION SUMMARY BY DATE</td></tr>
      <tr class="yh">
        <th>Date</th><th>Plastic</th><th>Paper</th><th>Metal</th><th>Wood</th><th>Glass</th><th>Total</th>
      </tr>
      ${dateRows}
      <tr>
        <td><b>TOTAL</b></td>
        ${SUMMARY_CATEGORIES.map((c) => `<td class="num"><b>${dateTotals[c]}</b></td>`).join('')}
        <td class="num"><b>${dateGrand}</b></td>
      </tr>
    </table>
    <table>
      <tr><td class="bar bar-gray">OBSERVATIONS</td></tr>
      <tr><td class="obs">${esc(remarkText)}<span class="hint">Observations regarding the monitoring results, unusual waste accumulation, or site conditions may be recorded here by the Barangay Sanitary Inspector.</span></td></tr>
      <tr><td class="bar bar-royal">RECOMMENDATIONS</td></tr>
      <tr><td class="obs">${esc(rec)}<span class="hint">Recommendations for coastal waste management and cleanup action may be provided here by the Barangay Sanitary Inspector.</span></td></tr>
    </table>
    <table class="signs">
      <tr>
        <td>
          Prepared by:
          <div class="ln">Barangay Sanitary Inspector<br/>Signature over Printed Name</div>
        </td>
        <td>
          Approved by:
          <div class="ln">Barangay Captain<br/>Signature over Printed Name</div>
        </td>
      </tr>
    </table>
    <div class="foot">This report was automatically generated from detection records of the Computer Vision-Based Coastal Waste Monitoring and Reporting System. Detailed records follow on the next page. Access the live dashboard for real-time monitoring.</div>
  </div>

  <div class="page">
    <table>
      <tr><td colspan="7" class="bar bar-green">COMPUTER VISION-BASED COASTAL WASTE MONITORING REPORT</td></tr>
      <tr><td colspan="7" class="sub"><b>WASTE DETECTION RECORDS</b></td></tr>
      <tr><td colspan="7" class="sub sub-gray">Generated Detection Records</td></tr>
      <tr><td colspan="7" class="bar bar-dgreen">MONITORING INFORMATION</td></tr>
      <tr><td class="lbl" colspan="2">Monitoring Period:</td><td colspan="5" class="val">${esc(period)}</td></tr>
      <tr><td class="lbl" colspan="2">Location:</td><td colspan="5" class="val">Paco Beach, Barangay Gracia</td></tr>
      <tr><td class="lbl" colspan="2">Camera ID:</td><td colspan="5" class="val">${esc(cams)}</td></tr>
      <tr><td class="lbl" colspan="2">Date Generated:</td><td colspan="5" class="val">${esc(generatedAt)}</td></tr>
      <tr><td colspan="7" class="bar bar-blue">DETECTION SUMMARY BY DATE</td></tr>
      <tr class="yh">
        <th>Detection ID</th>
        <th>Date &amp; Time</th>
        <th>Waste Category</th>
        <th>Waste Classification</th>
        <th>Confidence</th>
        <th>Count</th>
        <th>Camera</th>
      </tr>
      ${detRows}
    </table>
    <div class="foot">
      Note: This section contains the complete list of waste detections recorded during the selected monitoring period. Additional detection records will automatically continue on the succeeding page if necessary.<br/><br/>
      <b>End of Report</b><br/>
      This report was automatically generated by the Computer Vision-Based Coastal Waste Monitoring and Reporting System.
    </div>
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
