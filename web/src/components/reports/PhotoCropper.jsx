import { useCallback, useEffect, useRef, useState } from 'react';

const VIEW = 240; // size of the round crop window, px
const OUT = 256; // saved photo size, px
const MAX_ZOOM = 4;

/**
 * Round crop window: drag the picture to place it, zoom with the slider or
 * the mouse wheel. What is inside the circle is what gets saved.
 * getBlob() is exposed through `apiRef` for the Save button.
 */
export default function PhotoCropper({ image, apiRef }) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef(null);

  const w = image?.naturalWidth || 1;
  const h = image?.naturalHeight || 1;
  const base = VIEW / Math.min(w, h); // "cover" scale at zoom 1
  const scale = base * zoom;
  const dispW = w * scale;
  const dispH = h * scale;

  // Keep the picture covering the whole circle.
  const clamp = useCallback(
    (next, z = zoom) => {
      const s = base * z;
      const maxX = Math.max(0, (w * s - VIEW) / 2);
      const maxY = Math.max(0, (h * s - VIEW) / 2);
      return {
        x: Math.min(maxX, Math.max(-maxX, next.x)),
        y: Math.min(maxY, Math.max(-maxY, next.y)),
      };
    },
    [base, w, h, zoom],
  );

  // A new picture starts centered and not zoomed.
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [image]);

  const changeZoom = (z) => {
    const nextZoom = Math.min(MAX_ZOOM, Math.max(1, z));
    setZoom(nextZoom);
    setOffset((o) => clamp(o, nextZoom));
  };

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      getBlob: () =>
        new Promise((resolve, reject) => {
          const left = VIEW / 2 - dispW / 2 + offset.x;
          const top = VIEW / 2 - dispH / 2 + offset.y;
          const canvas = document.createElement('canvas');
          canvas.width = OUT;
          canvas.height = OUT;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, OUT, OUT);
          ctx.drawImage(image, -left / scale, -top / scale, VIEW / scale, VIEW / scale, 0, 0, OUT, OUT);
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not save this picture.'))), 'image/jpeg', 0.9);
        }),
    };
  }, [apiRef, image, dispW, dispH, offset, scale]);

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: offset };
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const { x, y, start } = drag.current;
    setOffset(clamp({ x: start.x + (e.clientX - x), y: start.y + (e.clientY - y) }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (e) => {
    e.preventDefault();
    changeZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  };
  const onKeyDown = (e) => {
    const step = e.shiftKey ? 20 : 6;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      setOffset((o) => clamp({ x: o.x + moves[e.key][0], y: o.y + moves[e.key][1] }));
    } else if (e.key === '+' || e.key === '=') {
      changeZoom(zoom + 0.1);
    } else if (e.key === '-') {
      changeZoom(zoom - 0.1);
    }
  };

  // Wheel must be non-passive to stop the page from scrolling.
  const viewRef = useRef(null);
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return undefined;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  if (!image) return null;

  return (
    <div className="crop">
      <div
        ref={viewRef}
        className="crop-view"
        style={{ width: VIEW, height: VIEW }}
        tabIndex={0}
        role="application"
        aria-label="Photo position. Drag or use the arrow keys to move; plus and minus to zoom."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <img
          src={image.src}
          alt=""
          draggable={false}
          style={{
            width: dispW,
            height: dispH,
            transform: `translate(${VIEW / 2 - dispW / 2 + offset.x}px, ${VIEW / 2 - dispH / 2 + offset.y}px)`,
          }}
        />
        <span className="crop-ring" aria-hidden="true" />
      </div>

      <div className="crop-tools">
        <button type="button" className="crop-zoom-btn" aria-label="Zoom out" onClick={() => changeZoom(zoom - 0.25)}>
          −
        </button>
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          aria-label="Zoom"
          onChange={(e) => changeZoom(Number(e.target.value))}
        />
        <button type="button" className="crop-zoom-btn" aria-label="Zoom in" onClick={() => changeZoom(zoom + 0.25)}>
          +
        </button>
        <button
          type="button"
          className="crop-reset"
          title="Reset"
          aria-label="Reset position and zoom"
          onClick={() => {
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      </div>
    </div>
  );
}
