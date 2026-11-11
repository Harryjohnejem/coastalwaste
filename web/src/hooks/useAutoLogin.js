import { useEffect } from 'react';
import { login as loginApi } from '../api/auth';
import { useAuthStore } from '../stores/useAuthStore';
import { useSettingsStore } from '../stores/useSettingsStore';

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
      .catch((err) => {
        console.error('Detection records sign-in failed', err);
        useSettingsStore.setState({
          detectionsLoaded: true,
          detectionsLoading: false,
          detectionsError: 'Unable to load detection records.',
        });
      });
  }, [token, setAuth]);
}
