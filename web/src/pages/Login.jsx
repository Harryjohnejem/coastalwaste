import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login as loginApi } from '../api/auth';
import { useAuthStore } from '../stores/useAuthStore';
import TideLine from '../components/layout/TideLine';
import AppNotice from '../components/common/AppNotice';

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
  const setAuth = useAuthStore((s) => s.setAuth);
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
      setAuth(data.token, data.user);
      navigate('/', { replace: true });
    } catch (err) {
      const status = err.response?.status;
      const msg = String(err.response?.data?.message || err.message || '');
      let next = 'Sign-in failed. Check your credentials and try again.';
      if (!err.response || err.code === 'ERR_NETWORK') {
        next = 'Cannot reach the API. Start php artisan serve on port 8000.';
      } else if (status === 500 || msg.includes('SQLSTATE') || msg.includes('Connection')) {
        next = 'Database is offline. Start MySQL (UniServer) then try again.';
      } else if (status === 422) {
        next = 'Wrong email or password.';
      }
      setError(next);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <TideLine />
      <div className="login-page">
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
        <form className="login-panel" onSubmit={handleSubmit}>
          <LoginLogo />
          <div className="brand-name">Brgy. Gracia</div>
          <h1>Sign in</h1>
          <p>Coastal Waste Monitoring and Reporting</p>

          <div className="field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="text"
              autoComplete="username"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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
                }}
                required
              />
              {password ? (
                <button
                  type="button"
                  className="login-pass-toggle"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setShowPassword((v) => !v)}
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
              onClick={() =>
                setForgotMsg('Contact the system administrator to reset your password.')
              }
            >
              Forgot Password
            </button>
          </div>
          {error ? <AppNotice type="error" title="Sign-in failed" message={error} /> : null}
          {forgotMsg ? <AppNotice type="info" title="Password reset" message={forgotMsg} /> : null}
          <button className="btn-save" type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </>
  );
}
