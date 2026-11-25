import FilterSelect from './FilterSelect';

export const HIT_LIMITS = [50, 100, 200, 500, 1000];

export function readHitLimit(storageKey, fallback = 50) {
  const saved = Number(sessionStorage.getItem(storageKey));
  return HIT_LIMITS.includes(saved) ? saved : fallback;
}

export default function HitLimitSelect({ id, value, onChange }) {
  return (
    <div className="hit-limit">
      <FilterSelect
        id={id}
        label="Hits per class"
        value={String(value)}
        options={HIT_LIMITS.map((count) => ({ value: String(count), label: String(count) }))}
        onChange={(next) => onChange(Number(next))}
      />
    </div>
  );
}
