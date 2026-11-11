import { useCameraStore } from '../../stores/useCameraStore';
import { useNavStore } from '../../stores/useNavStore';
import CameraCard from './CameraCard';

export default function CameraRail({ embedded = false }) {
  const cameras = useCameraStore((s) => s.cameras);
  const activeCameraId = useCameraStore((s) => s.activeCameraId);
  const loading = useCameraStore((s) => s.loading);
  const setActiveCamera = useCameraStore((s) => s.setActiveCamera);
  const openCameraModal = useCameraStore((s) => s.openCameraModal);
  const rescanCameras = useCameraStore((s) => s.rescanCameras);
  const setModule = useNavStore((s) => s.setModule);

  const online = cameras.filter(
    (c) => c.status === 'live' || c.status === 'LIVE' || c.status === 'online',
  ).length;

  const onSelect = (id) => {
    setActiveCamera(id);
    if (embedded) setModule('live');
  };

  const body = (
    <section
      className={`panel${embedded ? ' cams-embedded' : ''}`}
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}
    >
      <div className="panel-head">
        <span className="panel-title">
          Cameras · <b>{online}/{cameras.length} online</b>
        </span>
        <button className="mini-link" type="button" onClick={() => rescanCameras()}>
          Rescan
        </button>
      </div>
      <div className={`cam-list${embedded ? ' cam-list-grid' : ''}`}>
        {loading && cameras.length === 0 && (
          <>
            <div className="skeleton" style={{ height: 120 }} />
            <div className="skeleton" style={{ height: 120 }} />
          </>
        )}
        {cameras.map((cam) => (
          <CameraCard
            key={cam.id}
            camera={cam}
            active={cam.id === activeCameraId}
            onSelect={onSelect}
            onEdit={(id) => openCameraModal('edit', id)}
          />
        ))}
        <button
          className="add-cam"
          type="button"
          onClick={() => openCameraModal('add')}
        >
          + Add IP camera
        </button>
      </div>
    </section>
  );

  if (embedded) return body;
  return <aside className="cams">{body}</aside>;
}
