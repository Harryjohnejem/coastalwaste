/**
 * Renders CV bounding boxes from the Python YOLO detector (via API).
 */
export default function DetectionOverlay({ boxes, visible, showConfidence = true }) {
  if (!visible || !boxes?.length) return null;

  return (
    <>
      {boxes.map((box) => {
        const sand = box.variant === 'sand' || /net|fishing/i.test(box.class || '');
        const conf =
          box.confidence != null
            ? Number(box.confidence).toFixed(2)
            : null;
        const label =
          showConfidence && conf != null
            ? `${box.class} · ${conf}`
            : box.class;
        const style = box.left != null
          ? {
              left: `${box.left}%`,
              top: `${box.top}%`,
              width: `${box.width}%`,
              height: `${box.height}%`,
            }
          : {
              left: `${(box.x ?? 0) * 100}%`,
              top: `${(box.y ?? 0) * 100}%`,
              width: `${(box.w ?? box.width_norm ?? 0.1) * 100}%`,
              height: `${(box.h ?? box.height_norm ?? 0.1) * 100}%`,
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
