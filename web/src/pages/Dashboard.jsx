import { useEffect } from 'react';
import TideLine from '../components/layout/TideLine';
import TopBar from '../components/layout/TopBar';
import SideMenu from '../components/layout/SideMenu';
import CameraRail from '../components/cameras/CameraRail';
import CameraModal from '../components/cameras/CameraModal';
import Viewport from '../components/stage/Viewport';
import ControlDeck from '../components/stage/ControlDeck';
import DetectionLog from '../components/log/DetectionLog';
import WasteComposition from '../components/log/WasteComposition';
import WasteDetectionsModule from '../components/detections/WasteDetectionsModule';
import ReportsAnalytics from '../components/reports/ReportsAnalytics';
import SettingsModal from '../components/settings/SettingsModal';
import { useCameraStore } from '../stores/useCameraStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useNavStore } from '../stores/useNavStore';
import { POLL_INTERVAL_MS } from '../constants';
import { useAutoLogin } from '../hooks/useAutoLogin';

export default function Dashboard() {
  useAutoLogin();
  const module = useNavStore((s) => s.module);
  const setModule = useNavStore((s) => s.setModule);
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
  const fetchTrends = useSettingsStore((s) => s.fetchTrends);
  const fetchQuotas = useSettingsStore((s) => s.fetchQuotas);
  const fetchWasteCatalog = useSettingsStore((s) => s.fetchWasteCatalog);
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (module === 'quota') setModule('live');
  }, [module, setModule]);

  useEffect(() => {
    if (!token) return undefined;

    let cancelled = false;

    const boot = async () => {
      await fetchCameras();
      if (cancelled) return;
      await fetchSettings();
      if (cancelled) return;
      fetchDetections();
      fetchStats();
      fetchQuotas();
      fetchWasteCatalog();
      fetchComposition(module === 'reports' ? '30d' : '24h');
      if (module === 'reports') fetchTrends();
    };

    boot();

    const id = setInterval(() => {
      fetchDetections();
      fetchStats();
      if (module === 'reports') {
        fetchTrends();
        fetchComposition('30d');
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    token,
    module,
    fetchCameras,
    fetchSettings,
    fetchComposition,
    fetchDetections,
    fetchStats,
    fetchTrends,
    fetchQuotas,
    fetchWasteCatalog,
  ]);

  const connectStream = (url, protocol, latencyMs) => {
    if (latencyMs != null) setLatencyMs(latencyMs);
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

  const showLiveRail = module === 'live';

  return (
    <>
      <TideLine />
      <div className={`app${showLiveRail ? '' : ' app-wide'}`}>
        <TopBar />
        <SideMenu />
        {module === 'live' && (
          <>
            <main className="stage">
              <Viewport />
              <ControlDeck />
            </main>
            <aside className="log">
              <DetectionLog />
              <WasteComposition />
            </aside>
          </>
        )}
        {module === 'detections' && (
          <main className="stage module-stage">
            <WasteDetectionsModule />
          </main>
        )}
        {module === 'cameras' && (
          <main className="stage module-stage">
            <div className="module-pane">
              <header className="module-head">
                <div>
                  <h2 className="module-title">Cameras</h2>
                  <p className="module-sub">Manage IP cameras and live feeds for Brgy. Gracia.</p>
                </div>
              </header>
              <CameraRail embedded />
            </div>
          </main>
        )}
        {module === 'reports' && (
          <main className="stage module-stage">
            <ReportsAnalytics />
          </main>
        )}
      </div>
      <SettingsModal onTestStream={connectStream} />
      <CameraModal onConnectStream={connectStream} />
    </>
  );
}
