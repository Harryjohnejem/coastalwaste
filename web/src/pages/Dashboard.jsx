import { useEffect } from 'react';
import TideLine from '../components/layout/TideLine';
import TopBar from '../components/layout/TopBar';
import CameraRail from '../components/cameras/CameraRail';
import CameraModal from '../components/cameras/CameraModal';
import Viewport from '../components/stage/Viewport';
import ControlDeck from '../components/stage/ControlDeck';
import StatRow from '../components/stage/StatRow';
import DetectionLog from '../components/log/DetectionLog';
import WasteComposition from '../components/log/WasteComposition';
import SettingsModal from '../components/settings/SettingsModal';
import { useCameraStore } from '../stores/useCameraStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useAuthStore } from '../stores/useAuthStore';
import { POLL_INTERVAL_MS } from '../constants';
import { useAutoLogin } from '../hooks/useAutoLogin';

export default function Dashboard() {
  useAutoLogin();
  const fetchCameras = useCameraStore((s) => s.fetchCameras);
  const setStreamStatus = useCameraStore((s) => s.setStreamStatus);
  const setLatencyMs = useCameraStore((s) => s.setLatencyMs);
  const setActiveCamera = useCameraStore((s) => s.setActiveCamera);
  const activeCameraId = useCameraStore((s) => s.activeCameraId);
  const cameras = useCameraStore((s) => s.cameras);

  const fetchSettings = useSettingsStore((s) => s.fetchSettings);
  const fetchComposition = useSettingsStore((s) => s.fetchComposition);
  const fetchDetections = useSettingsStore((s) => s.fetchDetections);
  const fetchStats = useSettingsStore((s) => s.fetchStats);
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!token) return undefined;

    fetchCameras();
    fetchSettings();
    fetchComposition();
    fetchDetections();
    fetchStats();

    // TODO: replace polling with Laravel WebSockets/Reverb or Pusher
    const id = setInterval(() => {
      fetchDetections();
      fetchStats();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [
    token,
    fetchCameras,
    fetchSettings,
    fetchComposition,
    fetchDetections,
    fetchStats,
  ]);

  const connectStream = (url, protocol, latencyMs) => {
    if (latencyMs != null) setLatencyMs(latencyMs);
    // Prefer updating active camera URL so StreamPlayer picks it up.
    if (activeCameraId) {
      useCameraStore.setState((s) => ({
        cameras: s.cameras.map((c) =>
          c.id === activeCameraId
            ? { ...c, stream_url: url || c.stream_url, protocol: protocol || c.protocol }
            : c,
        ),
      }));
    } else if (cameras[0]) {
      setActiveCamera(cameras[0].id);
    }
    // Also mirror into settings stream URL for Connect CTA / Settings test.
    useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        stream: {
          ...s.settings.stream,
          url: url || s.settings.stream.url,
          protocol: protocol || s.settings.stream.protocol,
        },
      },
    }));
    setStreamStatus('CONNECTING…');
  };

  return (
    <>
      <TideLine />
      <div className="app">
        <TopBar />
        <CameraRail />
        <main className="stage">
          <Viewport />
          <ControlDeck />
          <StatRow />
        </main>
        <aside className="log">
          <DetectionLog />
          <WasteComposition />
        </aside>
      </div>
      <SettingsModal onTestStream={connectStream} />
      <CameraModal onConnectStream={connectStream} />
    </>
  );
}
