import { useEffect, useRef, useState } from 'react';
import { useCameraStore } from '../../stores/useCameraStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { captureSnapshot, startClipRecording } from '../../lib/mediaActions';

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatUptime(ms) {
  if (ms == null || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function parseClipMs(clipLength) {
  if (!clipLength) return 30000;
  if (/2\s*min/i.test(clipLength)) return 120000;
  if (/60/.test(clipLength)) return 60000;
  return 30000;
}

export default function ControlDeck() {
  const detectionOn = useCameraStore((s) => s.detectionOn);
  const setDetectionOn = useCameraStore((s) => s.setDetectionOn);
  const streamStatus = useCameraStore((s) => s.streamStatus);
  const liveSince = useCameraStore((s) => s.liveSince);
  const latencyMs = useCameraStore((s) => s.latencyMs);
  const gridView = useCameraStore((s) => s.gridView);
  const toggleGridView = useCameraStore((s) => s.toggleGridView);
  const recording = useCameraStore((s) => s.recording);
  const setRecording = useCameraStore((s) => s.setRecording);
  const deckNotice = useCameraStore((s) => s.deckNotice);
  const setDeckNotice = useCameraStore((s) => s.setDeckNotice);
  const activeCameraId = useCameraStore((s) => s.activeCameraId);
  const clipLength = useSettingsStore((s) => s.settings.station?.clipLength);

  const recorderRef = useRef(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!deckNotice) return undefined;
    const t = setTimeout(() => setDeckNotice(null), 3200);
    return () => clearTimeout(t);
  }, [deckNotice, setDeckNotice]);

  useEffect(() => {
    return () => {
      if (recorderRef.current) {
        recorderRef.current.stop?.();
        recorderRef.current = null;
      }
    };
  }, []);

  const clock = new Date(now).toLocaleTimeString('en-GB');
  const uptime =
    streamStatus === 'LIVE' && liveSince != null
      ? formatUptime(now - liveSince)
      : '—';
  const latency = latencyMs != null ? `${latencyMs} ms` : '—';

  const notice = (msg) => setDeckNotice(msg);

  const toggleDetect = () => {
    const next = !detectionOn;
    setDetectionOn(next);
    notice(next ? 'Detection overlay on' : 'Detection overlay off');
  };

  const handleSnapshot = async () => {
    setBusy(true);
    try {
      const name = await captureSnapshot(activeCameraId || 'tidalwatch');
      notice(`Snapshot saved · ${name}`);
    } catch (err) {
      notice(err.message || 'Snapshot failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleRecord = async () => {
    if (recording && recorderRef.current) {
      setBusy(true);
      try {
        const name = await recorderRef.current.stop();
        recorderRef.current = null;
        setRecording(false);
        notice(`Clip saved · ${name}`);
      } catch (err) {
        setRecording(false);
        recorderRef.current = null;
        notice(err.message || 'Could not save clip.');
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const session = startClipRecording(parseClipMs(clipLength));
      recorderRef.current = session;
      setRecording(true);
      notice('Recording… click again to stop');
      session.done
        .then((name) => {
          if (recorderRef.current === session) {
            recorderRef.current = null;
            setRecording(false);
            notice(`Clip saved · ${name}`);
          }
        })
        .catch((err) => {
          recorderRef.current = null;
          setRecording(false);
          notice(err.message || 'Recording failed.');
        });
    } catch (err) {
      notice(err.message || 'Could not start recording.');
    } finally {
      setBusy(false);
    }
  };

  const handleGrid = () => {
    toggleGridView();
    notice(!gridView ? 'Grid view on' : 'Single camera view');
  };

  const fullscreen = () => {
    const vp = document.getElementById('viewport');
    if (!vp) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else vp.requestFullscreen();
  };

  return (
    <div className="deck-wrap">
      <div className="deck">
        <button
          className={`deck-btn${detectionOn ? ' primary' : ''}`}
          type="button"
          onClick={toggleDetect}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2" />
          </svg>
          {detectionOn ? 'Detection on' : 'Detection off'}
        </button>
        <button
          className="deck-btn"
          type="button"
          disabled={busy}
          onClick={handleSnapshot}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          Snapshot
        </button>
        <button
          className={`deck-btn${recording ? ' primary recording' : ''}`}
          type="button"
          disabled={busy && !recording}
          onClick={handleRecord}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="4" fill="currentColor" />
          </svg>
          {recording ? 'Stop recording' : 'Record clip'}
        </button>
        <div className="deck-sep" />
        <button
          className={`deck-btn${gridView ? ' primary' : ''}`}
          type="button"
          onClick={handleGrid}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          {gridView ? 'Single view' : 'Grid view'}
        </button>
        <button className="deck-btn" type="button" onClick={fullscreen}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3" />
          </svg>
          Fullscreen
        </button>
        <div className="deck-spacer" />
        <span className="deck-stat">
          CLOCK <b>{clock}</b>
        </span>
        <span className="deck-stat">
          STREAM <b className={streamStatus === 'LIVE' ? 'deck-live' : undefined}>{streamStatus}</b>
        </span>
        <span className="deck-stat">
          UPTIME <b>{uptime}</b>
        </span>
        <span className="deck-stat">
          LATENCY <b>{latency}</b>
        </span>
      </div>
      {deckNotice && <div className="deck-notice">{deckNotice}</div>}
    </div>
  );
}
