import { useEffect, useRef, useState } from 'react';
import { useThemeStore } from '../../stores/useThemeStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useCameraStore } from '../../stores/useCameraStore';
import { useNavStore } from '../../stores/useNavStore';
import { locationOf } from '../../lib/wasteFilters';
import * as notificationsApi from '../../api/notifications';

function isOnline(cam) {
  const s = String(cam?.status || '').toLowerCase();
  return s === 'live' || s === 'online';
}

function formatWhen(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function TopBar() {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const quotas = useSettingsStore((s) => s.quotas);
  const liveDetections = useSettingsStore((s) => s.liveDetections);
  const cameras = useCameraStore((s) => s.cameras);
  const activeCameraId = useCameraStore((s) => s.activeCameraId);
  const setActiveCamera = useCameraStore((s) => s.setActiveCamera);
  const setModule = useNavStore((s) => s.setModule);
  const activeCamera = cameras.find((c) => c.id === activeCameraId) || cameras[0] || null;
  const cameraLocation = activeCamera
    ? locationOf({ location: activeCamera.location, sector: activeCamera.sector })
    : '—';
  const [clock, setClock] = useState({ date: '—', time: '--:--:--' });
  const [menuOpen, setMenuOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [notes, setNotes] = useState([]);
  const menuRef = useRef(null);
  const alertsRef = useRef(null);

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

  useEffect(() => {
    if (!menuOpen && !alertsOpen) return undefined;
    const onDoc = (e) => {
      if (menuOpen && !menuRef.current?.contains(e.target)) setMenuOpen(false);
      if (alertsOpen && !alertsRef.current?.contains(e.target)) setAlertsOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setAlertsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, alertsOpen]);

  const loadNotes = async () => {
    try {
      const data = await notificationsApi.listNotifications();
      const rows = Array.isArray(data?.notifications) ? data.notifications : [];
      if (rows.length) {
        setNotes(rows);
        return;
      }
    } catch {
      /* use local fallback */
    }
    const fallback = [];
    (quotas || []).forEach((q) => {
      const used = Number(q.used ?? q.current ?? 0);
      const limit = Number(q.limit ?? q.quota ?? 0);
      if (limit > 0 && used / limit >= 0.8) {
        fallback.push({
          id: `quota-${q.id || q.category}`,
          title: `${q.category || 'Waste'} quota`,
          message: `${used} / ${limit} — threshold reached.`,
          type: used >= limit ? 'danger' : 'warning',
          is_read: false,
          created_at: new Date().toISOString(),
        });
      }
    });
    (liveDetections || []).slice(0, 5).forEach((d) => {
      fallback.push({
        id: `det-${d.id}`,
        title: d.class || 'Detection',
        message: `${d.camera_id || 'Camera'} · ${locationOf(d)}`,
        type: d.severity === 'warn' ? 'warning' : 'info',
        is_read: false,
        created_at: d.detected_at_iso || d.detected_at,
      });
    });
    setNotes(fallback);
  };

  useEffect(() => {
    loadNotes();
    const id = setInterval(loadNotes, 20000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotas, liveDetections]);

  const unread = notes.filter((n) => !n.is_read).length;

  const selectCamera = (id) => {
    setActiveCamera(id);
    setModule('live');
    setMenuOpen(false);
  };

  const openAlerts = () => {
    setMenuOpen(false);
    setAlertsOpen((o) => !o);
    loadNotes();
  };

  const onMarkRead = async (note) => {
    setNotes((rows) => rows.map((n) => (n.id === note.id ? { ...n, is_read: true } : n)));
    if (typeof note.id === 'number' || /^\d+$/.test(String(note.id))) {
      try {
        await notificationsApi.markNotificationRead(note.id);
      } catch {
        /* local only */
      }
    }
  };

  const onMarkAll = async () => {
    setNotes((rows) => rows.map((n) => ({ ...n, is_read: true })));
    try {
      await notificationsApi.markAllNotificationsRead();
    } catch {
      /* local only */
    }
  };

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
          <div className="brand-name">Brgy. Gracia</div>
          <div className="brand-sub">Coastal Waste Monitoring and Reporting</div>
        </div>
      </div>

      <div className="topbar-location-wrap" ref={menuRef}>
        <button
          type="button"
          className={`topbar-location${menuOpen ? ' open' : ''}`}
          title="Switch camera"
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          onClick={() => {
            setAlertsOpen(false);
            setMenuOpen((o) => !o);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 21s-6-5.5-6-10a6 6 0 1112 0c0 4.5-6 10-6 10z" />
            <circle cx="12" cy="11" r="2.2" />
          </svg>
          <div className="topbar-location-text">
            <span className="topbar-location-label">Camera location</span>
            <span className="topbar-location-value">
              {activeCamera?.id ? `${activeCamera.id} · ${cameraLocation}` : cameraLocation}
            </span>
          </div>
          <span className="topbar-location-chev" aria-hidden="true">▼</span>
        </button>

        {menuOpen && (
          <ul className="topbar-cam-menu" role="listbox" aria-label="Select camera">
            {cameras.length === 0 && (
              <li className="topbar-cam-empty">No cameras available</li>
            )}
            {cameras.map((cam) => {
              const loc = locationOf({ location: cam.location, sector: cam.sector });
              const active = cam.id === activeCameraId;
              return (
                <li key={cam.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`topbar-cam-option${active ? ' active' : ''}`}
                    onClick={() => selectCamera(cam.id)}
                  >
                    <span className="topbar-cam-option-main">
                      <b>{cam.id}</b>
                      <span>{loc}</span>
                    </span>
                    <span className={`topbar-cam-status ${isOnline(cam) ? 'on' : 'off'}`}>
                      {isOnline(cam) ? 'LIVE' : 'OFF'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="topbar-spacer" />

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

      <div className="topbar-alerts-wrap" ref={alertsRef}>
        <button
          className={`icon-btn${alertsOpen ? ' open' : ''}`}
          type="button"
          title="Notifications"
          aria-label="Notifications"
          aria-haspopup="dialog"
          aria-expanded={alertsOpen}
          onClick={openAlerts}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M10.3 21a2 2 0 003.4 0" />
          </svg>
          {unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
        </button>
        {alertsOpen && (
          <div className="notif-panel" role="dialog" aria-label="Notifications">
            <div className="notif-head">
              <strong>Notifications</strong>
              {unread > 0 && (
                <button type="button" className="notif-mark-all" onClick={onMarkAll}>
                  Mark all read
                </button>
              )}
            </div>
            <ul className="notif-list">
              {notes.length === 0 && (
                <li className="notif-empty">No notifications yet.</li>
              )}
              {notes.map((note) => (
                <li key={note.id}>
                  <button
                    type="button"
                    className={`notif-item${note.is_read ? '' : ' unread'} type-${note.type || 'info'}`}
                    onClick={() => onMarkRead(note)}
                  >
                    <span className="notif-item-title">{note.title}</span>
                    <span className="notif-item-msg">{note.message}</span>
                    <span className="notif-item-time">{formatWhen(note.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <button
        className="icon-btn"
        type="button"
        title="Settings"
        aria-label="Open settings"
        onClick={() => openSettings()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3h.1a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5h.1a1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8v.1a1.6 1.6 0 001.5 1h.1a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" />
        </svg>
      </button>
    </header>
  );
}
