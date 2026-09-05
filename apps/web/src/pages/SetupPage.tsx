import { useState, type FormEvent } from 'react';

import { AnchorIcon, LinkIcon, ServerIcon, ShieldIcon } from '../components/Icons.js';
import { createAdmin } from '../lib/setup.js';

/**
 * First-run admin creation. Only ever rendered when `GET /api/setup` returns
 * `needsSetup: true`; if someone hits this route after the system is already
 * set up, the routing layer bounces them to `/login`.
 *
 * Sibling of `LoginPage` and deliberately identical in layout — same brand,
 * same panel, same aside. The only difference is the copy and the notice
 * explaining that no administrator exists yet. The two routes are never
 * reachable at the same time, so there is no link between them.
 */
export function SetupPage(): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createAdmin({ username: username.trim(), password });
      // Setup succeeded — the user still needs to sign in (we don't auto-issue
      // a session from the setup endpoint, by design: it keeps setup a
      // privileged write-only operation).
      //
      // Full-page navigation, not client-side `navigate('/login')`: App's
      // `fetchSetupStatus` runs once at mount and caches the result, so a
      // client-side route change would still see `needsSetup: true` and
      // bounce us straight back here via the catch-all. A real navigation
      // reboots App, which re-queries `/api/setup` and routes correctly.
      window.location.assign('/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.');
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
            <h1>First-run setup</h1>
            <p className="page-head-sub">Create the admin account for this instance.</p>
            <form
              onSubmit={onSubmit}
              className="stack"
              aria-busy={submitting}
              style={{ marginTop: 'var(--space-lg)' }}
            >
              <div className="notice">
                <div>
                  <span className="notice-title">No administrator yet</span>
                  This instance has no administrator. The account you create here owns it, and this
                  screen seals itself once it exists.
                </div>
              </div>
              <label className="field">
                <span className="field-label">Username</span>
                <input
                  type="text"
                  className="input"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  minLength={3}
                  maxLength={64}
                  required
                />
              </label>
              <label className="field">
                <span className="field-label">Password</span>
                <input
                  type="password"
                  className="input"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
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
                {submitting ? 'Creating…' : 'Create admin'}
              </button>
            </form>
          </section>
          <p className="micro faint" style={{ marginTop: 'var(--space-md)' }}>
            This screen disappears once an admin exists.
          </p>
        </div>
        <aside className="auth-aside">
          <div className="auth-aside-item">
            <ShieldIcon size={18} className="auth-aside-icon" />
            <div>
              <p className="auth-aside-title">Yours alone</p>
              <p className="auth-aside-body">
                Self-hosted, with a single administrator account. There is no public signup — the
                only way in is the credentials you set here.
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
