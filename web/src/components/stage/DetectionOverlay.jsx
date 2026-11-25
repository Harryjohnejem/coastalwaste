import { WASTE_CLASSES } from '../../constants';

/**
 * Renders CV bounding boxes from the Python YOLO detector (via API).
 * Accepts percent (0–100) or normalized (0–1) coordinates.
 */

function toPercent(value, sibling) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const samples = [value, sibling].map(Number).filter((v) => Number.isFinite(v));
  const looksPercent = samples.some((v) => v > 1.5);
  return looksPercent ? n : n * 100;
}

function boxKey(box, index) {
  if (box.track_id != null) return `track-${box.track_id}`;
  return box.id || `box-${index}`;
}

export default function DetectionOverlay({ boxes, visible, showConfidence = true }) {
  if (!visible || !boxes?.length) return null;

  return (
    <>
      {boxes.map((box, index) => {
        const key = boxKey(box, index);
        const knownClass = WASTE_CLASSES.some(
          (name) => name.toLowerCase() === String(box.class || '').toLowerCase(),
        );
        const unlabeled = Boolean(box.needs_label) && !knownClass;
        const sand = box.variant === 'sand' || /net|fishing/i.test(box.class || '');
        const rawConf = Number(box.confidence);
        const conf = Number.isFinite(rawConf)
          ? `${Math.round(rawConf > 1.5 ? rawConf : rawConf * 100)}%`
          : null;
        const stage = String(box.stage || '').toLowerCase();
        const pending =
          !unlabeled &&
          (box.provisional === true ||
            stage === 'detected' ||
            stage === 'confirming' ||
            (box.confirmed === false && stage !== 'recorded'));
        const labelParts = [unlabeled ? 'Unlabeled' : box.class];
        if (box.track_id != null) labelParts.push(`ID: ${box.track_id}`);
        if (showConfidence && conf != null) labelParts.push(conf);
        if (box.provisional === true || stage === 'detected') labelParts.push('provisional');
        else if (stage === 'confirming' && box.confirmed !== true) labelParts.push('tracking');

        let left;
        let top;
        let width;
        let height;

        if (box.left != null || box.top != null) {
          left = toPercent(box.left, box.width);
          top = toPercent(box.top, box.height);
          width = toPercent(box.width, box.left);
          height = toPercent(box.height, box.top);
        } else {
          left = (box.x ?? 0) * 100;
          top = (box.y ?? 0) * 100;
          width = (box.w ?? box.width_norm ?? 0.1) * 100;
          height = (box.h ?? box.height_norm ?? 0.1) * 100;
        }

        const style = {
          left: `${left}%`,
          top: `${top}%`,
          width: `${width}%`,
          height: `${height}%`,
        };

        return (
          <div
            key={key}
            className={`bbox${sand ? ' sand' : ''}${unlabeled ? ' unlabeled' : pending ? ' pending' : ' confirmed'}`}
            style={style}
          >
            <span className="tag">{labelParts.join(' · ')}</span>
          </div>
        );
      })}
    </>
  );
}
