/** Zoom lenses use the telephoto stream. The live screens keep the wide cameras. */
export function isZoomCamera(camera) {
  const url = String(camera?.stream_url || '');
  const name = String(camera?.name || camera?.camera_name || '');
  if (/src=cam04\b/i.test(url) || /\/stream6\b/i.test(url)) return true;
  return /second lens|telephoto|\bzoom\b/i.test(name);
}

export function wideCameras(cameras) {
  return (cameras || []).filter((camera) => camera && !isZoomCamera(camera));
}

/** Wide cameras that belong on the live dashboard grid. */
export function camerasInGrid(cameras) {
  return wideCameras(cameras).filter((camera) => camera.inGrid !== false);
}
