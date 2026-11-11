import { classifyWaste } from './wasteFilters';

export function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function buildDetectionCsv(detections, composition = []) {
  const lines = [
    'Republic of the Philippines',
    'Barangay Gracia, Tagoloan, Misamis Oriental',
    'Coastal Waste Monitoring and Reporting Form',
    `Generated,${new Date().toLocaleString()}`,
    '',
    'waste_type,classification,location,camera,confidence,count,time',
  ];
  detections.forEach((d) => {
    const { category, subtype } = classifyWaste(d);
    const conf =
      d.confidence != null
        ? Math.round(Number(d.confidence) * (d.confidence <= 1 ? 100 : 1))
        : '';
    lines.push(
      [
        `"${category}"`,
        `"${subtype}"`,
        `"${d.sector || ''}"`,
        d.camera_id || '',
        conf,
        d.count ?? '',
        d.detected_at || '',
      ].join(','),
    );
  });
  lines.push('');
  lines.push('composition_label,percent,count');
  composition.forEach((c) => {
    lines.push(`"${c.label}",${c.percent},${c.count ?? ''}`);
  });
  return lines.join('\n');
}
