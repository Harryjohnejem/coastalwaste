import { useSettingsStore } from '../../stores/useSettingsStore';

const FILL_CLASS = ['', 'c2', 'c3', 'c4'];

export default function WasteComposition() {
  const composition = useSettingsStore((s) => s.composition);
  const loading = useSettingsStore((s) => s.compositionLoading);

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Waste composition</span>
      </div>
      <div className="comp">
        {loading && composition.length === 0 && (
          <>
            <div className="skeleton" style={{ marginTop: 11 }} />
            <div className="skeleton" style={{ marginTop: 11 }} />
          </>
        )}
        {composition.map((row, i) => (
          <div className="comp-row" key={row.label}>
            <div className="comp-top">
              <span>{row.label}</span>
              <span>{row.count ?? 0} · {row.percent}%</span>
            </div>
            <div className="comp-bar">
              <div
                className={`comp-fill ${FILL_CLASS[i] || ''}`.trim()}
                style={{ width: `${row.percent}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
