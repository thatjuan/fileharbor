import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { StatusBadge } from '../components/StatusBadge.js';
import { listReceiveLinks, type ReceiveLink } from '../lib/api.js';
import { signOut, useSession } from '../lib/auth-client.js';

/**
 * Admin dashboard. Lists existing receive links + a "new link" button.
 * Link detail (and the new-link form) live on dedicated routes so the
 * URL is the source of truth for which view you're looking at.
 */
export function DashboardPage(): JSX.Element {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const [links, setLinks] = useState<ReceiveLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listReceiveLinks()
      .then((l) => {
        if (!cancelled) setLinks(l);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load links.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSignOut = async (): Promise<void> => {
    await signOut();
    navigate('/login', { replace: true });
  };

  const displayName =
    (session?.user as { displayUsername?: string | null } | undefined)?.displayUsername ??
    (session?.user as { username?: string | null } | undefined)?.username ??
    session?.user?.name ??
    'admin';

  return (
    <main className="page wide">
      <header className="row between">
        <h1>File Harbor</h1>
        <div className="row">
          <span className="muted">
            Signed in as <strong>{displayName}</strong>
          </span>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <section className="stack">
        <div className="row between">
          <h2>Receive links</h2>
          <Link to="/links/receive/new" className="button-link">
            New receive link
          </Link>
        </div>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        {links === null && !error && <p className="muted">Loading…</p>}

        {links !== null && links.length === 0 && (
          <p className="muted">No receive links yet. Create one to get started.</p>
        )}

        {links !== null && links.length > 0 && (
          <ul className="list-reset stack">
            {links.map((link) => (
              <li key={link.id} className="card row between">
                <div>
                  <Link to={`/links/receive/${link.id}`}>
                    <strong>{link.label}</strong>
                  </Link>
                  <div className="muted small">
                    Code <code>{link.code}</code> ·{' '}
                    {new Date(link.createdAt * 1000).toLocaleString()}
                  </div>
                </div>
                <StatusBadge status={link.displayStatus} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
