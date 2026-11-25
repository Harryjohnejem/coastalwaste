import { useEffect } from 'react';
import { bannerKey, useWasteLoadStore } from '../../stores/useWasteLoadStore';
import { useNavStore } from '../../stores/useNavStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { usePageSwitchStore } from '../../stores/usePageSwitchStore';
import usePageVisible from '../../hooks/usePageVisible';

const POLL_MS = 2000;

/**
 * Main dashboard banner for the cleanup threshold. Shows only when a camera is
 * building up (amber) or full (red), with a meter for each of those cameras.
 */
/** Today's Report: bring the Cleanup threshold card into view and flash it. */
function showCleanupCard() {
  const card = document.querySelector('.tr-cleanup');
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('is-flash');
  // Restart the highlight even when clicked twice.
  void card.offsetWidth;
  card.classList.add('is-flash');
}

/** poll=false: the page supplies the data itself (Today's Report sends it with each report). */
export default function CleanupAlert({ onToday = false, poll = true }) {
  const load = useWasteLoadStore((s) => s.load);
  const hiddenKey = useWasteLoadStore((s) => s.hiddenKey);
  const refresh = useWasteLoadStore((s) => s.refresh);
  const hide = useWasteLoadStore((s) => s.hide);
  const setModule = useNavStore((s) => s.setModule);
  const startSwitch = usePageSwitchStore((s) => s.start);
  const isAdmin = String(useAuthStore((s) => s.user?.role) || '').toLowerCase() === 'admin';
  const visible = usePageVisible();

  useEffect(() => {
    if (!visible || !poll) return undefined;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    // Coming back to the window: update at once instead of waiting for the next tick.
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', refresh);
    };
  }, [visible, poll, refresh]);

  if (!load?.enabled || load.level === 'normal' || hiddenKey === bannerKey(load)) return null;

  const hot = (load.cameras || [])
    .filter((c) => c.level !== 'normal')
    .sort((a, b) => b.percent - a.percent);
  const full = load.level === 'full';

  return (
    <div className={`cleanup-alert is-${load.level}`} role="alert">
      <span className="cleanup-alert-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4M12 17h.01" />
        </svg>
      </span>
      <div className="cleanup-alert-body">
        <strong>{full ? 'Cleanup needed — the beach is full' : 'Waste is building up'}</strong>
        <ul>
          {hot.map((c) => (
            <li key={c.code} className={`is-${c.level}`}>
              <span className="cleanup-alert-cam">{c.code}{c.location ? ` · ${c.location}` : ''}</span>
              <span className="cleanup-meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, c.percent)}%` }} />
                <i style={{ left: `${load.warn_percent}%` }} />
              </span>
              <span className="cleanup-alert-num">{c.count}/{load.limit}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="cleanup-alert-actions">
        <button type="button" className="cleanup-alert-go" onClick={() => {
            if (onToday) showCleanupCard();
            else if (isAdmin) startSwitch('/today', 'Loading Main Dashboard…');
            else setModule('detections');
          }}
        >
          {onToday ? 'View details' : 'View report'}
        </button>
        <button type="button" className="cleanup-alert-x" aria-label="Hide until the level changes" onClick={hide}>
          ×
        </button>
      </div>
    </div>
  );
}
