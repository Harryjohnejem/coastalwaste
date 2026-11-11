import { useEffect, useRef } from 'react';
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
import { CHART_POLL_MS, POLL_INTERVAL_MS, RECORDS_POLL_MS } from '../constants';
import { useAutoLogin } from '../hooks/useAutoLogin';
import usePageVisible from '../hooks/usePageVisible';

export default function Dashboard() {
  useAutoLogin();
  const pageVisible = usePageVisible();
  const module = useNavStore((s) => s.module);
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
  const fetchWasteCatalog = useSettingsStore((s) => s.fetchWasteCatalog);
  const token = useAuthStore((s) => s.token);
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (!token) {
      bootstrapped.current = false;
      return undefined;
    }

    let cancelled = false;
    (async () => {
      if (!bootstrapped.current) {
        await Promise.all([
          fetchDetections(50),
          fetchCameras(),
          fetchSettings(),
          fetchComposition('all'),
          fetchStats(),
          fetchTrends(),
          fetchWasteCatalog(),
        ]);
        bootstrapped.current = true;
      }
      if (cancelled) return;
      if (module === 'reports') fetchDetections(200);
    })();

    return () => {
      cancelled = true;
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
    fetchWasteCatalog,
  ]);

  useEffect(() => {
    if (!token || !pageVisible) return undefined;

    let liveRunning = false;
    let recordsRunning = false;
    let chartsRunning = false;

    const liveId = setInterval(() => {
      if (module !== 'live' || liveRunning) return;
      liveRunning = true;
      Promise.all([fetchDetections(50), fetchStats()]).finally(() => {
        liveRunning = false;
      });
    }, POLL_INTERVAL_MS);

    const recordsId = setInterval(() => {
      if (recordsRunning || module === 'cameras' || module === 'live') return;
      recordsRunning = true;
      const jobs = [fetchStats()];
      if (module === 'detections' || module === 'reports') {
        jobs.push(fetchDetections(module === 'reports' ? 200 : 50));
      }
      Promise.all(jobs).finally(() => {
        recordsRunning = false;
      });
    }, RECORDS_POLL_MS);

    const chartsId = setInterval(() => {
      if (chartsRunning) return;
      if (module !== 'live' && module !== 'reports') return;
      chartsRunning = true;
      const jobs = [fetchComposition(module === 'reports' ? '30d' : 'all')];
      if (module === 'reports') jobs.push(fetchTrends());
      Promise.all(jobs).finally(() => {
        chartsRunning = false;
      });
    }, CHART_POLL_MS);

    const camerasId = setInterval(() => {
      fetchCameras();
    }, 15000);

    return () => {
      clearInterval(liveId);
      clearInterval(recordsId);
      clearInterval(chartsId);
      clearInterval(camerasId);
    };
  }, [token, module, pageVisible, fetchCameras, fetchDetections, fetchStats, fetchComposition, fetchTrends]);

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
