import { useThemeStore } from '../../stores/useThemeStore';

/**
 * Night mode (dark) / Light switch. Used on the main dashboard top bar and on
 * Today's Report; both use the same app theme, so they always agree.
 */
export default function ModeSwitch({ className = 'mode-switch' }) {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  return (
    <div className={className} role="group" aria-label="Display mode">
      <button
        type="button"
        className={theme === 'dark' ? 'is-on' : ''}
        aria-pressed={theme === 'dark'}
        onClick={() => setTheme('dark')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        </svg>
        Night mode
      </button>
      <button
        type="button"
        className={theme === 'light' ? 'is-on' : ''}
        aria-pressed={theme === 'light'}
        onClick={() => setTheme('light')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
        Light
      </button>
    </div>
  );
}
