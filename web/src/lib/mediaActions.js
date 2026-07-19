/** Capture the live video or img inside #viewport as a PNG download. */
export function captureSnapshot(filenamePrefix = 'tidalwatch') {
  const root = document.getElementById('viewport');
  if (!root) throw new Error('Viewport not found.');

  const video = root.querySelector('.stream-video');
  const img = root.querySelector('.stream-img');
  const source =
    video && video.style.display !== 'none' && video.readyState >= 2
      ? video
      : img && img.style.display !== 'none' && img.naturalWidth
        ? img
        : null;

  if (!source) throw new Error('No live frame to capture. Wait until the stream is LIVE.');

  const w = source.videoWidth || source.naturalWidth || source.clientWidth;
  const h = source.videoHeight || source.naturalHeight || source.clientHeight;
  if (!w || !h) throw new Error('Frame not ready yet.');

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${filenamePrefix}-snapshot-${stamp}.png`;

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not encode snapshot.'));
        return;
      }
      downloadBlob(blob, name);
      resolve(name);
    }, 'image/png');
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Start recording the live <video> via MediaRecorder.
 * Returns { stop } — call stop() to finish and download the clip.
 */
export function startClipRecording(maxMs = 30000) {
  const root = document.getElementById('viewport');
  const video = root?.querySelector('.stream-video');
  if (!video || video.style.display === 'none' || video.readyState < 2) {
    throw new Error('No live video to record. Wait until the stream is LIVE.');
  }
  if (typeof video.captureStream !== 'function' && typeof video.mozCaptureStream !== 'function') {
    throw new Error('Clip recording is not supported in this browser.');
  }

  const stream = video.captureStream
    ? video.captureStream()
    : video.mozCaptureStream();

  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : MediaRecorder.isTypeSupported('video/webm')
      ? 'video/webm'
      : '';

  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data?.size) chunks.push(e.data);
  };

  let autoTimer = null;
  const stopPromise = new Promise((resolve, reject) => {
    recorder.onerror = () => reject(new Error('Recording failed.'));
    recorder.onstop = () => {
      if (autoTimer) clearTimeout(autoTimer);
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = `tidalwatch-clip-${stamp}.webm`;
      downloadBlob(blob, name);
      resolve(name);
    };
  });

  recorder.start(250);
  autoTimer = setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop();
  }, maxMs);

  return {
    stop: () => {
      if (recorder.state === 'recording') recorder.stop();
      return stopPromise;
    },
    done: stopPromise,
  };
}
