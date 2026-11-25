import { Navigate } from 'react-router-dom';
import TideLine from '../components/layout/TideLine';
import TodayReport from '../components/reports/TodayReport';
import CleanupAlert from '../components/common/CleanupAlert';
import { useAuthStore } from '../stores/useAuthStore';

/**
 * Today's Report on its own page (/today), separate from the main dashboard.
 * Only admins see it; everyone else goes to the dashboard.
 */
export default function TodayReportPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = String(user?.role || '').toLowerCase() === 'admin';

  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <>
      <TideLine />
      <div className="today-page">
        <TodayReport />
      </div>
      {/* Same cleanup alert as Live Monitoring; its data comes with each report. */}
      <CleanupAlert onToday poll={false} />
    </>
  );
}
