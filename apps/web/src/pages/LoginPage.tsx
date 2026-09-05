import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { AnchorIcon, LinkIcon, ServerIcon, ShieldIcon } from '../components/Icons.js';
import { signIn } from '../lib/auth-client.js';

/**
 * Login form. Username + password only — single-user, single-provider app.
 *
 * Renders outside the shell: no rail, no nav. The right-hand aside is the
 * only place a first-time operator learns what this instance is, so it says
 * what File Harbor actually does and nothing it doesn't.
 */
export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await signIn.username({ username: username.trim(), password });
      if (result.error) {
        setError(result.error.message ?? 'Sign-in failed.');
        return;
      }
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-layout">
        <div>
          <p className="auth-brand">
            <AnchorIcon size={18} />
            File Harbor
          </p>
          <section className="auth-panel">
            <h1>Sign in</h1>
            <p className="page-head-sub">Manage your receive and send links.</p>
            <form
              onSubmit={onSubmit}
              className="stack"
              aria-busy={submitting}
              style={{ marginTop: 'var(--space-lg)' }}
            >
              <label className="field">
                <span className="field-label">Username</span>
                <input
                  type="text"
                  className="input"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span className="field-label">Password</span>
                <input
                  type="password"
                  className="input"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <button
                type="submit"
                className="btn btn-accent"
                disabled={submitting}
                style={{ width: '100%' }}
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </section>
          <p className="micro faint" style={{ marginTop: 'var(--space-md)' }}>
            Forgot password? Contact your administrator.
          </p>
        </div>
        <aside className="auth-aside">
          <div className="auth-aside-item">
            <ShieldIcon size={18} className="auth-aside-icon" />
            <div>
              <p className="auth-aside-title">Yours alone</p>
              <p className="auth-aside-body">
                Self-hosted, with a single administrator account. There is no public signup — the
                only way in is the credentials you set.
              </p>
            </div>
          </div>
          <div className="auth-aside-item">
            <LinkIcon size={18} className="auth-aside-icon" />
            <div>
              <p className="auth-aside-title">Links, not accounts</p>
              <p className="auth-aside-body">
                Share a receive link to collect files or a send link to hand them over. Nobody you
                share with needs an account.
              </p>
            </div>
          </div>
          <div className="auth-aside-item">
            <ServerIcon size={18} className="auth-aside-icon" />
            <div>
              <p className="auth-aside-title">Straight to your storage</p>
              <p className="auth-aside-body">
                Bytes move browser-to-storage over presigned URLs — local disk or any S3-compatible
                bucket you point it at.
              </p>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
