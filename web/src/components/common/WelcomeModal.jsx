import { useEffect, useRef } from 'react';

/** Maayong buntag (5–11), hapon (12–17), gabii (18–4), with a matching icon. */
function greetingFor(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return { text: 'Maayong buntag', icon: 'sun' };
  if (hour >= 12 && hour < 18) return { text: 'Maayong hapon', icon: 'sunset' };
  return { text: 'Maayong gabii', icon: 'moon' };
}

function GreetingIcon({ kind }) {
  const common = {
    width: 30,
    height: 30,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };
  if (kind === 'moon') {
    return (
      <svg {...common}>
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
      </svg>
    );
  }
  if (kind === 'sunset') {
    return (
      <svg {...common}>
        <path d="M17 18a5 5 0 0 0-10 0" />
        <path d="M12 9V3M4.2 10.2l1.4 1.4M1 18h2M21 18h2M18.4 11.6l1.4-1.4M23 22H1" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </svg>
  );
}

/**
 * Shown on the login page right after a successful sign-in, over the blurred
 * login video. The button opens the dashboard; × goes back to the login form.
 */
export default function WelcomeModal({ name, count, onOpen, onClose }) {
  const greeting = greetingFor();
  const button = useRef(null);
  const firstName = String(name || '').trim().split(/\s+/)[0] || 'User';

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="welcome-modal" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <button className="welcome-close" type="button" aria-label="Back to sign in" onClick={onClose}>
        ×
      </button>
      <div className={`welcome-icon is-${greeting.icon}`}>
        <GreetingIcon kind={greeting.icon} />
      </div>
      <h2 id="welcome-title">
        {greeting.text}, {firstName}
      </h2>
      <p className="welcome-sub">Welcome back.</p>
      <div className="welcome-alert" role="status">
        <AlertIcon />
        <span>
          {`${count == null ? '…' : Number(count).toLocaleString('en-US')} ka ${count === 1 ? 'detection' : 'detections'} kinahanglan tan-awon`}
        </span>
      </div>
      <button ref={button} className="btn-save welcome-open" type="button" onClick={onOpen}>
        Tan-awa ang report karon
      </button>
    </div>
  );
}
