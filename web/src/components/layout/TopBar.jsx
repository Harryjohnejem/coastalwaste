import { useEffect, useRef, useState } from 'react';
import ModeSwitch from '../common/ModeSwitch';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useCameraStore } from '../../stores/useCameraStore';
import { useNavStore } from '../../stores/useNavStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { FLASH_CLEANUP_KEY, useFocusStore } from '../../stores/useFocusStore';
import { usePageSwitchStore } from '../../stores/usePageSwitchStore';
import { locationOf } from '../../lib/wasteFilters';
import * as notificationsApi from '../../api/notifications';
import usePageVisible from '../../hooks/usePageVisible';

/** Poll while the administrator stays logged in. */
const NOTIFICATION_POLL_MS = 15000;

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
  const pageVisible = usePageVisible();
  const openSettings = useSettingsStore((s) => s.openSettings);
  const stationName = useSettingsStore((s) => s.settings?.station?.name) || 'Brgy. Gracia';
  const token = useAuthStore((s) => s.token);
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
  const [unread, setUnread] = useState(0);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState(null);
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

  const loadNotes = async ({ silent = false } = {}) => {
    if (!token) {
      setNotes([]);
      setUnread(0);
      setNotesError(null);
      return;
    }
    if (!silent) setNotesLoading(true);
    try {
      const data = await notificationsApi.listNotifications();
      const rows = Array.isArray(data?.notifications) ? data.notifications : [];
      setNotes(rows);
      setUnread(Number(data?.unread ?? rows.filter((n) => !n.is_read).length));
      setNotesError(null);
    } catch {
      setNotesError('Could not load notifications.');
    } finally {
      if (!silent) setNotesLoading(false);
    }
  };

  useEffect(() => {
    if (!token) {
      setNotes([]);
      setUnread(0);
      setNotesError(null);
      setAlertsOpen(false);
      return undefined;
    }
    loadNotes();
    if (!pageVisible) return undefined;
    const id = setInterval(() => loadNotes({ silent: true }), NOTIFICATION_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, pageVisible]);

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

  /** Where a notification leads: a detection record, or the cleanup threshold. */
  const targetOf = (note) => {
    if (note?.detection_id) return 'detection';
    if (/^(Cleanup needed|Waste building up|Back to normal|Cleaned) ·/.test(String(note?.title || ''))) return 'cleanup';
    return null;
  };

  const openNote = (note) => {
    onMarkRead(note);
    const target = targetOf(note);
    if (!target) return;
    setAlertsOpen(false);
    if (target === 'detection') {
      useFocusStore.getState().focusDetection(note.detection_id);
      setModule('detections');
      return;
    }
    const isAdmin = String(useAuthStore.getState().user?.role || '').toLowerCase() === 'admin';
    if (isAdmin) {
      try {
        sessionStorage.setItem(FLASH_CLEANUP_KEY, '1');
      } catch {
        /* the card still shows; it just is not highlighted */
      }
      usePageSwitchStore.getState().start('/today', 'Loading Main Dashboard…');
    } else {
      setModule('live');
    }
  };

  const onMarkRead = async (note) => {
    if (note.is_read) return;
    setNotes((rows) => rows.map((n) => (n.id === note.id ? { ...n, is_read: true } : n)));
    setUnread((count) => Math.max(0, count - 1));
    try {
      await notificationsApi.markNotificationRead(note.id);
    } catch {
      setNotes((rows) => rows.map((n) => (n.id === note.id ? { ...n, is_read: false } : n)));
      setUnread((count) => count + 1);
      setNotesError('Could not mark notification as read.');
    }
  };

  const onMarkAll = async () => {
    const previous = notes;
    const previousUnread = unread;
    setNotes((rows) => rows.map((n) => ({ ...n, is_read: true })));
    setUnread(0);
    try {
      await notificationsApi.markAllNotificationsRead();
    } catch {
      setNotes(previous);
      setUnread(previousUnread);
      setNotesError('Could not mark notifications as read.');
    }
  };

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <img src="/brgy-gracia-seal.jpg" alt="" />
        </div>
        <div>
          <div className="brand-name">{stationName}</div>
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
              {activeCamera?.name || activeCamera?.id || cameraLocation}
            </span>
          </div>
          <span className="topbar-location-chev" aria-hidden="true">▼</span>
        </button>

        {menuOpen && (
          <ul className="topbar-cam-menu" role="listbox" aria-label="Select camera">
            {cameras.length === 0 && (
              <li className="topbar-cam-empty">No cameras available</li>
            )}
            {cameras.map((camera) => {
              const loc = locationOf({ location: camera.location, sector: camera.sector });
              const named = camera.name && camera.name !== camera.id
                ? camera.name.replace(new RegExp(`^${camera.id}\\s*·\\s*`, 'i'), '')
                : loc;
              const active = camera.id === activeCameraId;
              const online = isOnline(camera);
              return (
                <li key={camera.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`topbar-cam-option${active ? ' active' : ''}`}
                    onClick={() => selectCamera(camera.id)}
                  >
                    <span className="topbar-cam-option-main">
                      <b>{camera.id}</b>
                      <span>{named}</span>
                    </span>
                    <span className={`topbar-cam-status ${online ? 'on' : 'off'}`}>
                      {online ? 'LIVE' : 'OFF'}
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

      <ModeSwitch />

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
              {notesLoading && notes.length === 0 && (
                <li className="notif-empty">Loading notifications…</li>
              )}
              {!notesLoading && notesError && notes.length === 0 && (
                <li className="notif-empty">{notesError}</li>
              )}
              {!notesLoading && !notesError && notes.length === 0 && (
                <li className="notif-empty">No notifications yet.</li>
              )}
              {notesError && notes.length > 0 && (
                <li className="notif-empty">{notesError}</li>
              )}
              {notes.map((note) => (
                <li key={note.id}>
                  <button
                    type="button"
                    className={`notif-item${note.is_read ? '' : ' unread'} type-${note.type || 'info'}`}
                    onClick={() => openNote(note)}
                  >
                    <span className="notif-item-title">{note.title}</span>
                    <span className="notif-item-msg">{note.message}</span>
                    <span className="notif-item-time">
                      {formatWhen(note.created_at)}
                      {targetOf(note) ? <span className="notif-item-go">View →</span> : null}
                    </span>
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
