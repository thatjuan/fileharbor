import { useState, type FormEvent } from 'react';

import { createAdmin } from '../lib/setup.js';

/**
 * First-run admin creation. Only ever rendered when `GET /api/setup` returns
 * `needsSetup: true`; if someone hits this route after the system is already
 * set up, the routing layer bounces them to `/login`.
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
    <main className="page-auth">
      <h1>Set up File Harbor</h1>
      <p className="lead">
        Create the admin account for this instance. This screen disappears once an admin exists.
      </p>
      <form onSubmit={onSubmit} className="stack">
        <label className="input-label">
          Username
          <input
            type="text"
            className="input-pill"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            minLength={3}
            maxLength={64}
            required
          />
        </label>
        <label className="input-label">
          Password
          <input
            type="password"
            className="input-pill"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </label>
        {error && (
          <p role="alert" className="muted">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create admin'}
        </button>
      </form>
    </main>
  );
}
