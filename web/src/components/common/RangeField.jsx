export default function RangeField({ id, value, min, max, format, onChange }) {
  const display = format ? format(value) : value;
  return (
    <div className="range-wrap">
      <input
        type="range"
        id={id}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange?.(Number(e.target.value))}
      />
      <span className="range-val">{display}</span>
    </div>
  );
}
