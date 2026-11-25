/** One physical Tapo camera has a wide lens and a zoom lens. */
export const LENS_UNITS = [
  { id: 'unit-1', name: 'Camera 1', wideId: 'CAM-01', zoomId: 'CAM-01Z' },
  { id: 'unit-2', name: 'Camera 2', wideId: 'CAM-02', zoomId: 'CAM-02Z' },
];

export function unitForCamera(cameraId) {
  const id = String(cameraId || '').toUpperCase();
  return LENS_UNITS.find((unit) => unit.wideId === id || unit.zoomId === id) || null;
}

export function unitsFromCameras(cameras) {
  const list = cameras || [];
  return LENS_UNITS.map((unit) => ({
    ...unit,
    wide: list.find((camera) => String(camera.id).toUpperCase() === unit.wideId) || null,
    zoom: list.find((camera) => String(camera.id).toUpperCase() === unit.zoomId) || null,
  })).filter((unit) => unit.wide || unit.zoom);
}
