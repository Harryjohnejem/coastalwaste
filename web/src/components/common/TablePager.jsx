import FilterSelect from './FilterSelect';

export const PAGE_SIZES = [10, 25, 50, 100, 200];

export function readPageSize(storageKey, fallback = 50) {
  try {
    const saved = Number(window.localStorage.getItem(storageKey));
    return PAGE_SIZES.includes(saved) ? saved : fallback;
  } catch {
    return fallback;
  }
}

export function savePageSize(storageKey, value) {
  try {
    window.localStorage.setItem(storageKey, String(value));
  } catch {
    // Storage can be blocked; the choice just won't be remembered.
  }
}

/** Page numbers with gaps, e.g. 1 2 3 … 39 or 1 … 7 8 9 … 39. */
function pageItems(current, last) {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const pages = new Set([1, last, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((p) => pages.add(p));
  if (current >= last - 2) [last - 3, last - 2, last - 1].forEach((p) => pages.add(p));
  const sorted = [...pages].filter((p) => p >= 1 && p <= last).sort((a, b) => a - b);
  const items = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) items.push(`gap-${p}`);
    items.push(p);
  });
  return items;
}

export default function TablePager({
  id,
  page,
  lastPage,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  disabled = false,
}) {
  const safeLast = Math.max(1, lastPage);
  const current = Math.min(Math.max(1, page), safeLast);
  const start = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const end = Math.min(total, current * pageSize);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const go = (p) => {
    if (disabled || p < 1 || p > safeLast || p === current) return;
    onPageChange(p);
  };

  return (
    <div className="table-pager">
      <div className="table-pager-size">
        <span className="table-pager-label">Per page:</span>
        <FilterSelect
          id={id}
          value={String(pageSize)}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(next) => onPageSizeChange(Number(next))}
        />
      </div>
      <div className="table-pager-nav">
        <span className="table-pager-range">
          {fmt(start)} - {fmt(end)} of {fmt(total)}
        </span>
        <button
          type="button"
          className="table-pager-btn"
          aria-label="Previous page"
          disabled={disabled || current <= 1}
          onClick={() => go(current - 1)}
        >
          ‹
        </button>
        {pageItems(current, safeLast).map((item) => (typeof item === 'number' ? (
          <button
            key={item}
            type="button"
            className={`table-pager-btn${item === current ? ' is-current' : ''}`}
            aria-current={item === current ? 'page' : undefined}
            disabled={disabled}
            onClick={() => go(item)}
          >
            {item}
          </button>
        ) : (
          <span key={item} className="table-pager-gap">…</span>
        )))}
        <button
          type="button"
          className="table-pager-btn"
          aria-label="Next page"
          disabled={disabled || current >= safeLast}
          onClick={() => go(current + 1)}
        >
          ›
        </button>
      </div>
    </div>
  );
}
