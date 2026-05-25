import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { createAdmin } from '../lib/setup.js';

/**
 * First-run admin creation. Only ever rendered when `GET /api/setup` returns
 * `needsSetup: true`; if someone hits this route after the system is already
 * set up, the routing layer bounces them to `/login`.
 */
export function SetupPage(): JSX.Element {
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
      await createAdmin({ username: username.trim(), password });
      // Setup succeeded — the user still needs to sign in (we don't auto-issue
      // a session from the setup endpoint, by design: it keeps setup a
      // privileged write-only operation).
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="page">
      <h1>Set up File Harbor</h1>
      <p>
        Create the admin account for this instance. This screen disappears once an admin exists.
      </p>
      <form onSubmit={onSubmit} className="stack">
        <label>
          Username
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            minLength={3}
            maxLength={64}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
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
        <button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create admin'}
        </button>
      </form>
    </main>
  );
}
