export default function Switch({ checked, onChange, id }) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        id={id}
        checked={Boolean(checked)}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="slider" />
    </label>
  );
}
