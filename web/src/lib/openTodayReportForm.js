import { getTodayStats } from '../api/detections';
import { getReportRecords } from '../api/reports';
import { listCameras } from '../api/cameras';
import { wideCameras } from './gridCameras';
import { categoryRows, formatPeriodLabel } from './reportAnalytics';
import {
  buildMonitoringNotes,
  buildOfficialReportHtml,
  buildReportData,
  datasetClassOf,
  nextReportNumber,
} from './reportForm';

/**
 * Inputs for the report form, the same as Reports & Analytics → Export PDF
 * with Reporting Period "All Dates" and "All Cameras": every saved record
 * (no 1000-row limit), the KPI stats, observations and recommendations.
 */
export async function loadReportInputs(generatedBy = 'Administrator') {
  const [rows, stats, cameraRows] = await Promise.all([
    getReportRecords(),
    getTodayStats(),
    listCameras().catch(() => []),
  ]);
  const list = Array.isArray(rows) ? rows : rows?.data ?? [];
  const detections = list
    .filter((d) => datasetClassOf(d) && String(d.status || '') !== 'Ignored')
    .slice()
    .sort((a, b) => String(b.detected_at || '').localeCompare(String(a.detected_at || '')));
  const periodLabel = formatPeriodLabel('All Dates', '', '', null);
  const notes = buildMonitoringNotes(detections, { periodLabel, comparison: null });

  // All Cameras: every camera on the system (plus any camera that has records).
  const cameras = [
    ...wideCameras(Array.isArray(cameraRows) ? cameraRows : cameraRows?.data ?? []).map((c) => c.id),
    ...detections.map((d) => d.camera_id),
  ].filter(Boolean);

  return {
    generatedBy,
    cameras,
    monitoringPeriod: `Paco Beach, Barangay Gracia · ${periodLabel}`,
    remarks: notes.observation,
    recommendations: notes.recommendation,
    stats: stats || {},
    composition: categoryRows(detections),
    detections,
  };
}

/** The digital form on the Main Dashboard (tables). */
export async function loadReportData(generatedBy) {
  return buildReportData(await loadReportInputs(generatedBy));
}

/**
 * The printable official form (same numbers) in a new tab; print or save as
 * PDF from there. The tab opens inside the click so the browser allows it.
 */
export async function openTodayReportForm(generatedBy = 'Administrator', reportNumber = '') {
  const win = window.open('', '_blank');
  if (!win) {
    throw new Error('The browser blocked the new tab. Allow pop-ups for this site, then try again.');
  }
  win.document.title = 'Report form';
  win.document.body.innerHTML =
    '<p style="font:15px system-ui,sans-serif;padding:32px;color:#334155">Loading the report form…</p>';

  try {
    const inputs = await loadReportInputs(generatedBy);
    const html = buildOfficialReportHtml({ ...inputs, reportNumber: reportNumber || nextReportNumber(), reportType: 'Summary' });
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (err) {
    win.document.body.innerHTML =
      '<p style="font:15px system-ui,sans-serif;padding:32px;color:#b91c1c">Could not load the report form. Close this tab and try again.</p>';
    throw err;
  }
}
