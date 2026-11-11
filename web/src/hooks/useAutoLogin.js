import { useEffect } from 'react';
import { login as loginApi } from '../api/auth';
import { useAuthStore } from '../stores/useAuthStore';

/** Signs in with demo API credentials when no token is stored. */
export function useAutoLogin() {
  const token = useAuthStore((s) => s.token);
  const setAuth = useAuthStore((s) => s.setAuth);

  useEffect(() => {
    if (token) return;

    const email = import.meta.env.VITE_DEMO_EMAIL || 'dioquinojimscarl@tcc.edu.ph';
    const password = import.meta.env.VITE_DEMO_PASSWORD || 'tapolink123';

    loginApi(email, password)
      .then((data) => setAuth(data.token, data.user))
      .catch(() => {
        // API may be offline — dashboard keeps template mock data.
      });
  }, [token, setAuth]);
}
