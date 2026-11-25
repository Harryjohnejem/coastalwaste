import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login as loginApi } from '../api/auth';
import { useAuthStore } from '../stores/useAuthStore';
import TideLine from '../components/layout/TideLine';
import WelcomeModal from '../components/common/WelcomeModal';
import { getTodayStats } from '../api/detections';
import { useNavStore } from '../stores/useNavStore';
import { useTodayReportStore } from '../stores/useTodayReportStore';
import { WELCOME_PENDING_KEY } from '../constants';

function readWelcomePending() {
  try {
    return sessionStorage.getItem(WELCOME_PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

function writeWelcomePending(on) {
  try {
    if (on) sessionStorage.setItem(WELCOME_PENDING_KEY, '1');
    else sessionStorage.removeItem(WELCOME_PENDING_KEY);
  } catch {
    // Private window: the modal still works until a refresh.
  }
}


function LoginLogo() {
  return (
    <div className="login-logo">
      <img src="/brgy-gracia-seal.jpg" alt="Barangay Gracia, Tagoloan, Mis. Or." />
    </div>
  );
}

function EyeIcon({ off = false }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {off ? (
        <>
          <path d="M3 3l18 18" />
          <path d="M10.6 10.6a2 2 0 002.8 2.8" />
          <path d="M9.9 5.1A10.9 10.9 0 0112 5c7 0 11 7 11 7a18.5 18.5 0 01-3.2 3.9" />
          <path d="M6.1 6.1C3.5 8 2 12 2 12s4 7 10 7a10.4 10.4 0 004.3-.9" />
        </>
      ) : (
        <>
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

/**
 * Minimal login — isolated auth surface (token via Zustand + localStorage).
 * Delete this page + useAuthStore + client interceptors together if API has no auth.
 */
export default function Login() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const setAuth = useAuthStore((s) => s.setAuth);
  const setModule = useNavStore((s) => s.setModule);
  // Set before setAuth so the redirect below waits for the welcome modal.
  // Survives a refresh: the user has not clicked the welcome window yet.
  const welcomePending = useRef(readWelcomePending());
  const [welcome, setWelcome] = useState(() => {
    if (!welcomePending.current) return null;
    const { token: saved, user } = useAuthStore.getState();
    return saved ? { name: user?.name, count: null } : null;
  });
  const welcomeOpen = Boolean(welcome);

  // After a refresh: load the live count at once instead of waiting 3 s.
  useEffect(() => {
    if (!welcomePending.current || !useAuthStore.getState().token) {
      writeWelcomePending(false);
      welcomePending.current = false;
      return;
    }
    getTodayStats()
      .then((stats) => {
        const value = Number(stats?.present);
        if (Number.isFinite(value)) setWelcome((w) => (w ? { ...w, count: value } : w));
      })
      .catch(() => {});
  }, []);

  // Real time while the welcome window is open: the count follows the cameras.
  useEffect(() => {
    if (!welcomeOpen) return undefined;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const stats = await getTodayStats();
        const value = Number(stats?.present);
        if (alive && Number.isFinite(value)) {
          setWelcome((w) => (w && w.count !== value ? { ...w, count: value } : w));
        }
      } catch {
        // Keep the last number; the next tick tries again.
      }
    }, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [welcomeOpen]);
  const logout = useAuthStore((s) => s.logout);

  useEffect(() => {
    if (token && !welcomePending.current) navigate('/', { replace: true });
  }, [token, navigate]);

  const openTodayReport = () => {
    const isAdmin = String(useAuthStore.getState().user?.role || '').toLowerCase() === 'admin';
    if (!isAdmin) {
      enterDashboard('detections');
      return;
    }
    welcomePending.current = false;
    writeWelcomePending(false);
    useTodayReportStore.getState().prefetch();
    navigate('/today', { replace: true });
  };

  const enterDashboard = (module) => {
    if (module) setModule(module);
    welcomePending.current = false;
    writeWelcomePending(false);
    navigate('/', { replace: true });
  };

  // × on the welcome modal: sign out again and show the login form.
  const backToLogin = () => {
    welcomePending.current = false;
    writeWelcomePending(false);
    setWelcome(null);
    setPassword('');
    logout();
  };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [forgotMsg, setForgotMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const markReady = () => setVideoReady(true);
    if (video.readyState >= 2) markReady();

    video.play().catch(() => {});

    video.addEventListener('loadeddata', markReady);
    video.addEventListener('playing', markReady);
    video.addEventListener('canplay', markReady);
    return () => {
      video.removeEventListener('loadeddata', markReady);
      video.removeEventListener('playing', markReady);
      video.removeEventListener('canplay', markReady);
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setForgotMsg('');
    setLoading(true);
    try {
      const data = await loginApi(email, password);
      welcomePending.current = true;
      writeWelcomePending(true);
      setAuth(data.token, data.user, remember);
      // Get the live count first, so the modal opens once with its final size
      // (the Sign in button keeps showing "Signing in…" meanwhile).
      let count = 0;
      try {
        const stats = await Promise.race([
          getTodayStats(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 8000)),
        ]);
        // Waste still on the beach right now: the same number as "Active" on
        // Live Monitoring and "Still on the beach" on Today's Report.
        const value = Number(stats?.present);
        count = Number.isFinite(value) ? value : 0;
      } catch {
        count = 0;
      }
      setWelcome({ name: data.user?.name, count });
    } catch (err) {
      const status = err.response?.status;
      const msg = String(err.response?.data?.message || err.message || '');
      let next = 'Sign-in failed. Check your credentials and try again.';
      if (!err.response || err.code === 'ERR_NETWORK') {
        next = 'Cannot reach the API. Start php artisan serve on port 8000.';
      } else if (status === 500 || msg.includes('SQLSTATE') || msg.includes('Connection')) {
        next = 'Database is offline. Start MySQL (UniServer) then try again.';
      } else if (status === 422) {
        next = 'Wrong username or password.';
      }
      setError(next);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <TideLine />
      <div className={`login-page${welcome ? ' is-welcome' : ''}`}>
        <img className="login-bg-img" src="/login-coast.jpg" alt="" />
        <video
          ref={videoRef}
          className={`login-bg-img login-bg-video${videoReady ? ' is-ready' : ''}`}
          src="/0920(1).mp4"
          poster="/login-coast.jpg"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          onCanPlay={() => setVideoReady(true)}
          onLoadedData={() => setVideoReady(true)}
          onPlaying={() => setVideoReady(true)}
        />
        <div className="login-bg-veil" aria-hidden="true" />
        {welcome ? (
          <WelcomeModal
            name={welcome.name}
            count={welcome.count}
            onOpen={openTodayReport}
            onClose={backToLogin}
          />
        ) : null}
        <form className="login-panel" onSubmit={handleSubmit} hidden={Boolean(welcome)}>
          <LoginLogo />
          <div className="brand-name">Brgy. Gracia</div>
          <h1>Sign in</h1>
          <p>Coastal Waste Monitoring and Reporting</p>

          <div className="field">
            <label htmlFor="login-email">Username</label>
            <input
              id="login-email"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Enter your username"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error) setError('');
              }}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <div className={`login-pass-wrap${password ? ' is-active' : ''}`}>
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => {
                  const next = e.target.value;
                  setPassword(next);
                  if (!next) setShowPassword(false);
                  if (error) setError('');
                }}
                required
              />
              {password ? (
                <button
                  type="button"
                  className="login-pass-toggle"
                  // Reachable with Tab; Enter or Space toggles. A mouse click keeps
                  // the cursor in the password field.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-controls="login-password"
                  aria-pressed={showPassword}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  <EyeIcon off={showPassword} />
                </button>
              ) : null}
            </div>
          </div>
          <div className="login-options">
            <label className="login-remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>Remember me</span>
            </label>
            <button
              className="login-forgot"
              type="button"
              onClick={() => {
                setError('');
                setForgotMsg('Contact the system administrator to reset your password.');
              }}
            >
              Forgot password?
            </button>
          </div>
          {/* One short line at a time: the sign-in error, or the password-reset tip. */}
          {error || forgotMsg ? (
            <p className={`login-msg ${error ? 'is-error' : 'is-info'}`} role={error ? 'alert' : 'status'}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                {error ? <path d="M12 7.5v5M12 16h.01" /> : <path d="M12 11v5M12 8h.01" />}
              </svg>
              <span>{error || forgotMsg}</span>
            </p>
          ) : null}
          <button className="btn-save" type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </>
  );
}
