import { useNavStore } from '../../stores/useNavStore';

const MODULES = [
  {
    id: 'live',
    label: 'Live Monitor',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M23 7l-7 5 7 5V7z" />
        <rect x="1" y="5" width="15" height="14" rx="2" />
      </svg>
    ),
  },
  {
    id: 'detections',
    label: 'Waste Detections',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2" />
      </svg>
    ),
  },
  {
    id: 'cameras',
    label: 'Cameras',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M14.5 4h-5L7 7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2h-3l-2.5-3z" />
        <circle cx="12" cy="13" r="3" />
      </svg>
    ),
  },
  {
    id: 'reports',
    label: 'Reports & Analytics',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M3 3v18h18" />
        <path d="M7 14l4-4 4 3 5-7" />
      </svg>
    ),
  },
];

export default function SideMenu() {
  const module = useNavStore((s) => s.module);
  const setModule = useNavStore((s) => s.setModule);

  return (
    <aside className="side-menu">
      <div className="panel side-menu-panel">
        <div className="panel-head">
          <span className="panel-title">Modules</span>
        </div>
        <nav className="side-menu-nav" aria-label="Application modules">
          {MODULES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`side-menu-item${module === m.id ? ' active' : ''}`}
              aria-current={module === m.id ? 'page' : undefined}
              onClick={() => setModule(m.id)}
            >
              <span className="side-menu-icon" aria-hidden="true">
                {m.icon}
              </span>
              <span>{m.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </aside>
  );
}
