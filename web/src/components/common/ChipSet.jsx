export default function ChipSet({ options, selected, onToggle }) {
  return (
    <div className="chip-set">
      {options.map((label) => {
        const on = selected.includes(label);
        return (
          <button
            key={label}
            type="button"
            className={`chip${on ? ' on' : ''}`}
            onClick={() => onToggle?.(label)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
