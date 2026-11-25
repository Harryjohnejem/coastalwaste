import { useEffect, useRef } from 'react';

export default function TableSelectAll({
  allSelected,
  someSelected,
  disabled,
  onToggle,
  count = 0,
  label,
}) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(someSelected && !allSelected);
  }, [someSelected, allSelected]);

  return (
    <button
      type="button"
      className="deck-btn det-select-all-btn"
      disabled={disabled}
      onClick={onToggle}
      aria-pressed={allSelected}
    >
      <input
        ref={ref}
        type="checkbox"
        checked={allSelected}
        disabled={disabled}
        tabIndex={-1}
        readOnly
        aria-hidden="true"
      />
      {label || (allSelected ? 'Clear all' : 'Select all')}
      {count ? ` (${count})` : ''}
    </button>
  );
}
