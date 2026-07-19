import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login as loginApi } from '../api/auth';
import { useAuthStore } from '../stores/useAuthStore';
import TideLine from '../components/layout/TideLine';

/**
 * Minimal login — isolated auth surface (token via Zustand + localStorage).
 * Delete this page + useAuthStore + client interceptors together if API has no auth.
 */
export default function Login() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await loginApi(email, password);
      setAuth(data.token, data.user);
      navigate('/', { replace: true });
    } catch {
      setError('Sign-in failed. Check your credentials and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <TideLine />
      <div className="login-page">
        <form className="login-panel" onSubmit={handleSubmit}>
          <div className="brand-name">
            Tidal<em>Watch</em>
          </div>
          <h1>Station sign-in</h1>
          <p>Authenticate to the coastal monitoring API.</p>

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
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <div className="field-error">{error}</div>}
          <button className="btn-save" type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </>
  );
}
