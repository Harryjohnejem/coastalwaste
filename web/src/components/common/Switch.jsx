export default function Switch({ checked, onChange, id, disabled = false }) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        id={id}
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="slider" />
    </label>
  );
}
