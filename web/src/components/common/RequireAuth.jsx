import { useEffect } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { currentUser } from '../../api/auth';
import { useClassesStore } from '../../stores/useClassesStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { WELCOME_PENDING_KEY } from '../../constants';

/** The dashboard opens only after the user signs in on the login page. */
export default function RequireAuth() {
  const token = useAuthStore((s) => s.token);

  // Keep the saved name in step with the server (e.g. after the account is renamed).
  useEffect(() => {
    if (!token) return;
    // Classes of the deployed model and the waste catalog (not only the original 11).
    useClassesStore.getState().load();
    currentUser()
      .then((user) => {
        const state = useAuthStore.getState();
        if (user && state.token === token && JSON.stringify(user) !== JSON.stringify(state.user)) {
          state.setAuth(token, user);
        }
      })
      .catch(() => {});
  }, [token]);

  if (!token) {
    return <Navigate to="/login" replace />;
  }
  // Signed in but the welcome window is still waiting for a click.
  let welcomePending = false;
  try {
    welcomePending = sessionStorage.getItem(WELCOME_PENDING_KEY) === '1';
  } catch {
    welcomePending = false;
  }
  if (welcomePending) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
