import { useEffect, useRef, useState } from 'react';
import { useCameraStore } from '../../stores/useCameraStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { captureSnapshot, startClipRecording } from '../../lib/mediaActions';
import { acknowledgeAction, confirmThenRun } from '../../stores/useNoticeStore';
import { DEFAULT_RECORDING_SECONDS, recordingLengthLabel } from '../../constants';

// Clip recording button next to Detection on/off.
const SHOW_RECORD_BUTTON = true;

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
  // Clip length from Settings → Recording option.
  const clipSeconds = useSettingsStore(
    (s) => Number(s.settings?.recording?.clip_max_seconds) || DEFAULT_RECORDING_SECONDS,
  );
  const clipLabel = recordingLengthLabel(clipSeconds);
  const streamStatus = useCameraStore((s) => s.streamStatus);
  const liveSince = useCameraStore((s) => s.liveSince);
  const latencyMs = useCameraStore((s) => s.latencyMs);
  const gridView = useCameraStore((s) => s.gridView);
  const toggleGridView = useCameraStore((s) => s.toggleGridView);
  const cameras = useCameraStore((s) => s.cameras);
  const cycleCamera = useCameraStore((s) => s.cycleCamera);
  const activeCameraId = useCameraStore((s) => s.activeCameraId);
  const recording = useCameraStore((s) => s.recording);
  const setRecording = useCameraStore((s) => s.setRecording);
  const canCycle = cameras.length > 1;

  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const clipRef = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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

  const clock = new Date(now).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const uptime =
    streamStatus === 'LIVE' && liveSince != null
      ? formatUptime(now - liveSince)
      : '—';
  const latency = latencyMs != null ? `${latencyMs} ms` : '—';

  // The button flips at once (green = on). The save to Laravel runs in the
  // background; if it fails, the store restores the previous state.
  const toggleDetect = async () => {
    const next = !detectionOn;
    const saved = await useSettingsStore.getState().setDetectionEnabled(next);
    if (!saved && useCameraStore.getState().detectionOn !== next) {
      const settingsError = useSettingsStore.getState().settingsError;
      await acknowledgeAction({
        title: 'Detection setting not saved',
        message: settingsError || 'The detection state could not be saved. The previous state was restored.',
        variant: 'danger',
      });
    }
  };

  const handleRecord = async () => {
    if (recording && clipRef.current) {
      setBusy(true);
      const outcome = await confirmThenRun({
        title: 'Stop recording?',
        message: 'The clip will be saved to this station.',
        confirmLabel: 'Stop and save',
        busyTitle: 'Saving recording',
        busyMessage: 'Stopping the clip and saving the file.',
        busyLabel: 'Saving…',
        successTitle: 'Recording saved',
        successMessage: (name) => `Recording saved · ${name}`,
        errorTitle: 'Recording not saved',
        work: () => clipRef.current.stop(),
      });
      if (!outcome.cancelled) {
        clipRef.current = null;
        setRecording(false);
      }
      setBusy(false);
      return;
    }

    if (gridView) {
      await acknowledgeAction({
        title: 'Cannot record',
        message: 'Switch to single camera view to record.',
        variant: 'warning',
      });
      return;
    }
    if (streamStatus !== 'LIVE') {
      await acknowledgeAction({
        title: 'Cannot record',
        message: 'Wait until the stream is LIVE before recording.',
        variant: 'warning',
      });
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
    const outcome = await confirmThenRun({
      title: 'Start recording?',
      message: `Tap Record again to stop. Recording stops and saves after ${clipLabel}.`,
      confirmLabel: 'Start recording',
      busyTitle: 'Starting recording',
      busyMessage: 'Starting the clip on the live camera.',
      busyLabel: 'Starting…',
      successTitle: 'Recording',
      successMessage: `Recording is on. Tap Record again to stop (max ${clipLabel}).`,
      errorTitle: 'Recording did not start',
      work: async () => {
        const prefix = String(activeCameraId || 'brgy-gracia')
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-');
        const session = startClipRecording(prefix, clipSeconds * 1000);
        clipRef.current = session;
        setRecording(true);
        session.done
          .then(async (name) => {
            if (clipRef.current !== session) return;
            clipRef.current = null;
            setRecording(false);
            await acknowledgeAction({
              title: 'Recording saved',
              message: `Recording saved · ${name}`,
            });
          })
          .catch(async (err) => {
            if (clipRef.current !== session) return;
            clipRef.current = null;
            setRecording(false);
            await acknowledgeAction({
              title: 'Recording failed',
              message: err.message || 'Recording failed.',
              variant: 'danger',
            });
          });
      },
    });
    if (!outcome.ok) setRecording(false);
    setBusy(false);
  };

  const handleSnapshot = async () => {
    if (gridView) {
      await acknowledgeAction({
        title: 'Cannot capture',
        message: 'Switch to single camera view to capture.',
        variant: 'warning',
      });
      return;
    }
    if (streamStatus !== 'LIVE') {
      await acknowledgeAction({
        title: 'Cannot capture',
        message: 'Wait until the stream is LIVE before capturing.',
        variant: 'warning',
      });
      return;
    }
    setBusy(true);
    try {
      const prefix = String(activeCameraId || 'brgy-gracia')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-');
      await captureSnapshot(prefix);
    } catch (err) {
      await acknowledgeAction({
        title: 'Snapshot not saved',
        message: err.message || 'Could not capture a still image.',
        variant: 'danger',
      });
    }
    setBusy(false);
  };

  const handleGrid = () => {
    toggleGridView();
  };

  const handlePrevLens = () => {
    if (!canCycle) return;
    cycleCamera(-1);
  };

  const handleNextLens = () => {
    if (!canCycle) return;
    cycleCamera(1);
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
          aria-pressed={detectionOn}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2" />
          </svg>
          {detectionOn ? 'Detection on' : 'Detection off'}
        </button>
        {SHOW_RECORD_BUTTON ? (
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
        ) : null}
        <button
          className="deck-btn"
          type="button"
          disabled={busy}
          onClick={handleSnapshot}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          Snapshot
        </button>
        <div className="deck-sep" />
        <button
          className="deck-btn"
          type="button"
          onClick={handlePrevLens}
          disabled={!canCycle}
          title="Previous camera"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Prev
        </button>
        <button
          className="deck-btn"
          type="button"
          onClick={handleNextLens}
          disabled={!canCycle}
          title="Next camera"
        >
          Next
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
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
    </div>
  );
}
