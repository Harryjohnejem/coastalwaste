import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login as loginApi } from '../api/auth';
import { useAuthStore } from '../stores/useAuthStore';
import { notice } from '../stores/useNoticeStore';
import TideLine from '../components/layout/TideLine';

function LoginLogo() {
  return (
    <div className="login-logo">
      <img src="/login-icon.png" alt="Brgy. Gracia" />
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

  useEffect(() => {
    if (token) navigate('/', { replace: true });
  }, [token, navigate]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [passFocused, setPassFocused] = useState(false);
  const [error, setError] = useState('');
  const [forgotMsg, setForgotMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [bgReady, setBgReady] = useState(false);
  const [videoReady, setVideoReady] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setForgotMsg('');
    setLoading(true);
    try {
      const data = await loginApi(email, password);
      setAuth(data.token, data.user);
      notice.success('Signed in', `Welcome back${data.user?.name ? `, ${data.user.name}` : ''}.`);
      navigate('/', { replace: true });
    } catch (err) {
      const timedOut = err?.code === 'ECONNABORTED' || err?.message?.includes('timeout');
      const message = timedOut
        ? 'Sign-in timed out. The API is busy — wait a second and try again.'
        : 'Sign-in failed. Check your credentials and try again.';
      setError(message);
      notice.error('Sign-in failed', message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <TideLine />
      <div className="login-page">
        <img
          className={`login-bg-img${bgReady ? ' is-ready' : ''}`}
          src="/login-coast.jpg"
          alt=""
          onLoad={() => setBgReady(true)}
        />
        <video
          className={`login-bg-img login-bg-video${videoReady ? ' is-ready' : ''}`}
          src="/bg.mp4.mov?v=2"
          poster="/login-coast.jpg"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          onCanPlay={() => setVideoReady(true)}
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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <div className={`login-pass-wrap${passFocused ? ' is-active' : ''}`}>
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={() => setPassFocused(true)}
                onBlur={() => setPassFocused(false)}
                required
              />
              {passFocused ? (
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
          {error && <div className="field-error">{error}</div>}
          <button className="btn-save" type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          <button
            className="login-forgot"
            type="button"
            onClick={() => {
              const msg = 'Contact the system administrator to reset your password.';
              setForgotMsg(msg);
              notice.info('Password reset', msg);
            }}
          >
            Forgot password?
          </button>
          {forgotMsg ? <p className="login-forgot-hint">{forgotMsg}</p> : null}
        </form>
      </div>
    </>
  );
}
