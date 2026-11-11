import { useEffect, useId, useRef, useState } from 'react';

/**
 * Custom listbox so filter options always show (native <select> menus
 * often fail to appear on dark-themed Windows).
 */
export default function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
  placeholder,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);
  const display = current?.label || placeholder || value || 'Select';

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const groups = [];
  let currentGroup = { label: null, items: [] };
  for (const opt of options) {
    const g = opt.group || null;
    if (g !== currentGroup.label) {
      if (currentGroup.items.length) groups.push(currentGroup);
      currentGroup = { label: g, items: [opt] };
    } else {
      currentGroup.items.push(opt);
    }
  }
  if (currentGroup.items.length) groups.push(currentGroup);

  return (
    <div className="filter-field filter-select-wrap" ref={wrapRef}>
      {label && (
        <label htmlFor={id} id={`${id}-label`}>
          {label}
        </label>
      )}
      <button
        id={id}
        type="button"
        className={`filter-select-btn${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label`}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="filter-select-value">{display}</span>
        <span className="filter-select-chev" aria-hidden="true">
          ▼
        </span>
      </button>
      {open && (
        <ul id={listId} className="filter-select-menu" role="listbox" aria-labelledby={`${id}-label`}>
          {options.length === 0 && (
            <li className="filter-select-empty">No options</li>
          )}
          {groups.flatMap((group) => {
            const nodes = [];
            if (group.label) {
              nodes.push(
                <li key={`g-${group.label}`} className="filter-select-group-label" role="presentation">
                  {group.label}
                </li>,
              );
            }
            group.items.forEach((opt) => {
              const active = opt.value === value;
              nodes.push(
                <li key={opt.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`filter-select-option${active ? ' active' : ''}${opt.kind === 'action' ? ' action' : ''}`}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    {opt.label}
                  </button>
                </li>,
              );
            });
            return nodes;
          })}
        </ul>
      )}
    </div>
  );
}
