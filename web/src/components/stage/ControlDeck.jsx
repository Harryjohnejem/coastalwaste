import { useEffect, useRef, useState } from 'react';
import { useCameraStore } from '../../stores/useCameraStore';
import { startClipRecording } from '../../lib/mediaActions';

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

export default function ControlDeck() {
  const detectionOn = useCameraStore((s) => s.detectionOn);
  const setDetectionOn = useCameraStore((s) => s.setDetectionOn);
  const streamStatus = useCameraStore((s) => s.streamStatus);
  const liveSince = useCameraStore((s) => s.liveSince);
  const latencyMs = useCameraStore((s) => s.latencyMs);
  const gridView = useCameraStore((s) => s.gridView);
  const toggleGridView = useCameraStore((s) => s.toggleGridView);
  const deckNotice = useCameraStore((s) => s.deckNotice);
  const setDeckNotice = useCameraStore((s) => s.setDeckNotice);
  const activeCameraId = useCameraStore((s) => s.activeCameraId);
  const recording = useCameraStore((s) => s.recording);
  const setRecording = useCameraStore((s) => s.setRecording);

  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const clipRef = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!deckNotice) return undefined;
    const t = setTimeout(() => setDeckNotice(null), 3200);
    return () => clearTimeout(t);
  }, [deckNotice, setDeckNotice]);

  // Stop recording if camera / grid changes or component unmounts
  useEffect(() => {
    return () => {
      if (clipRef.current) {
        try {
          clipRef.current.stop();
        } catch {
          /* ignore */
        }
        clipRef.current = null;
      }
      setRecording(false);
    };
  }, [activeCameraId, gridView, setRecording]);

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

  const handleRecord = async () => {
    if (recording && clipRef.current) {
      setBusy(true);
      try {
        const name = await clipRef.current.stop();
        notice(`Recording saved · ${name}`);
      } catch (err) {
        notice(err.message || 'Could not save recording.');
      } finally {
        clipRef.current = null;
        setRecording(false);
        setBusy(false);
      }
      return;
    }

    if (gridView) {
      notice('Switch to single camera view to record.');
      return;
    }
    if (streamStatus !== 'LIVE') {
      notice('Wait until the stream is LIVE before recording.');
      return;
    }

    setBusy(true);
    try {
      const prefix = String(activeCameraId || 'brgy-gracia')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-');
      const session = startClipRecording(prefix, 120000);
      clipRef.current = session;
      setRecording(true);
      notice('Recording… tap Record again to stop (max 2 min)');

      session.done
        .then((name) => {
          if (clipRef.current !== session) return;
          clipRef.current = null;
          setRecording(false);
          notice(`Recording saved · ${name}`);
        })
        .catch((err) => {
          if (clipRef.current !== session) return;
          clipRef.current = null;
          setRecording(false);
          notice(err.message || 'Recording failed.');
        });
    } catch (err) {
      notice(err.message || 'Could not start recording.');
      setRecording(false);
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
          className={`deck-btn${recording ? ' recording' : ''}`}
          type="button"
          disabled={busy}
          onClick={handleRecord}
          aria-pressed={recording}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {recording ? (
              <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />
            ) : (
              <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
            )}
            <circle cx="12" cy="12" r="9" />
          </svg>
          {recording ? 'Stop' : 'Record'}
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
