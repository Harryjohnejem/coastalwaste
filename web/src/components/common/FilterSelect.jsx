import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

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
  const [dropUp, setDropUp] = useState(false);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);
  const display = current?.label || placeholder || value || 'Select';

  // Open upward when the menu would run past the bottom of the screen.
  useLayoutEffect(() => {
    if (!open) {
      setDropUp(false);
      return;
    }
    const btn = wrapRef.current?.querySelector('.filter-select-btn');
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const rect = btn.getBoundingClientRect();
    const needed = menu.offsetHeight + 8;
    // Respect a scrolling parent (e.g. a modal body) that would clip the menu.
    let top = 0;
    let bottom = window.innerHeight;
    for (let el = wrapRef.current?.parentElement; el && el !== document.body; el = el.parentElement) {
      const { overflowY } = window.getComputedStyle(el);
      if (/(auto|scroll|hidden)/.test(overflowY)) {
        const box = el.getBoundingClientRect();
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
        break;
      }
    }
    const below = bottom - rect.bottom;
    const above = rect.top - top;
    setDropUp(below < needed && above > below);
  }, [open]);

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
        aria-label={`${label ? `${label}: ` : ''}${display}`}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="filter-select-value">{display}</span>
        <span className="filter-select-chev" aria-hidden="true">
          ▼
        </span>
      </button>
      {open && (
        <ul
          id={listId}
          ref={menuRef}
          className={`filter-select-menu${dropUp ? ' drop-up' : ''}`}
          role="listbox" aria-labelledby={`${id}-label`}>
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
