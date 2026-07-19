import { useEffect, useState } from 'react';
import { useThemeStore } from '../../stores/useThemeStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { ENV_STRIP } from '../../data/mock';

export default function TopBar() {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const stationName = useSettingsStore((s) => s.settings.station.name);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const [clock, setClock] = useState({ date: '—', time: '--:--:--' });

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock({
        date: now.toLocaleDateString('en-GB', {
          weekday: 'short',
          day: '2-digit',
          month: 'short',
        }),
        time: now.toLocaleTimeString('en-GB'),
      });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M2 14c2.5-2.5 5-2.5 7.5 0s5 2.5 7.5 0 4-2 5 0" />
            <path d="M2 19c2.5-2.5 5-2.5 7.5 0s5 2.5 7.5 0 4-2 5 0" />
            <circle cx="12" cy="6" r="2.6" />
          </svg>
        </div>
        <div>
          <div className="brand-name">
            Tidal<em>Watch</em>
          </div>
          <div className="brand-sub">Coastal Waste Monitor</div>
        </div>
      </div>

      <button className="station" type="button" title="Switch monitoring station">
        <span className="dot" aria-hidden="true" />
        <span>{stationName}</span>
        <span className="chev">▼</span>
      </button>

      <div className="topbar-spacer" />

      <div className="env-strip" aria-label="Environmental conditions">
        <div className="env-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 3v3M5.6 5.6l2 2M3 12h3M18.4 5.6l-2 2M21 12h-3M8 20a4 4 0 118 0z" />
          </svg>
          Tide <b>{ENV_STRIP.tide}</b>
        </div>
        <div className="env-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 8h9a3 3 0 100-3M3 12h13a3 3 0 110 3M3 16h7a3 3 0 110 3" />
          </svg>
          Wind <b>{ENV_STRIP.wind}</b>
        </div>
        <div className="env-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
          Visibility <b>{ENV_STRIP.visibility}</b>
        </div>
      </div>

      <div className="clock">
        <span>{clock.date}</span> ·{' '}
        <span style={{ color: 'var(--foam)' }}>{clock.time}</span>
      </div>

      <button
        className="icon-btn"
        type="button"
        title="Toggle light / dark mode"
        aria-label="Toggle light or dark mode"
        aria-pressed={theme === 'light'}
        onClick={toggleTheme}
      >
        {theme === 'dark' ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        )}
      </button>

      <button className="icon-btn" type="button" title="Alerts" aria-label="Alerts">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M10.3 21a2 2 0 003.4 0" />
        </svg>
        <span className="badge">3</span>
      </button>

      <button
        className="icon-btn"
        type="button"
        title="Settings"
        aria-label="Open settings"
        onClick={openSettings}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3h.1a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5h.1a1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8v.1a1.6 1.6 0 001.5 1h.1a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" />
        </svg>
      </button>
    </header>
  );
}
