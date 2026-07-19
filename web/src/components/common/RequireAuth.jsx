import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../../stores/useAuthStore';

/** Protects dashboard routes. Remove with Login + auth store if API has no auth. */
export default function RequireAuth() {
  const token = useAuthStore((s) => s.token);

  // If no token yet and API is unreachable, still allow dashboard for local UI work
  // when VITE_AUTH_REQUIRED is not set. Default: require auth when a token might exist,
  // but allow unauthenticated access so an empty Laravel skeleton doesn't block the UI.
  // Set VITE_AUTH_REQUIRED=true to enforce login.
  const authRequired = import.meta.env.VITE_AUTH_REQUIRED === 'true';

  if (authRequired && !token) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
