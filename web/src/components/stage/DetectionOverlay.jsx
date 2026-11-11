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

export default function DetectionOverlay({ boxes, visible, showConfidence = true }) {
  if (!visible || !boxes?.length) return null;

  return (
    <>
      {boxes.map((box) => {
        const sand = box.variant === 'sand' || /net|fishing/i.test(box.class || '');
        const conf =
          box.confidence != null ? Number(box.confidence).toFixed(2) : null;
        const label =
          showConfidence && conf != null
            ? `${box.class} ${conf}`
            : box.class;

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
            key={box.id || `${box.class}-${style.left}-${style.top}`}
            className={`bbox${sand ? ' sand' : ''}`}
            style={style}
          >
            <span className="tag">{label}</span>
          </div>
        );
      })}
    </>
  );
}
