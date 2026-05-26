import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { StatusBadge } from '../components/StatusBadge.js';
import { SubNav } from '../components/SubNav.js';
import { listReceiveLinks, listSendLinks, type ReceiveLink, type SendLink } from '../lib/api.js';
import { signOut, useSession } from '../lib/auth-client.js';

/**
 * Admin dashboard at `/`. Renders inside `AdminShell`, so the page itself
 * only owns the SubNav (section title + new-link CTAs) and the link
 * inventory below it.
 *
 * Receive and send links are listed as `.store-card` grids — two side-by-side
 * sections, each with its own heading and empty state. Cards lead to the
 * dedicated detail pages, which are the source of truth for per-link actions
 * (revoke, copy URL, etc.); we keep the dashboard quiet.
 */
export function DashboardPage(): JSX.Element {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const [links, setLinks] = useState<ReceiveLink[] | null>(null);
  const [sendLinks, setSendLinks] = useState<SendLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Two independent loads; failure of one doesn't blank the other. Both go
    // out in parallel — total wait time is the slower of the two.
    listReceiveLinks()
      .then((l) => {
        if (!cancelled) setLinks(l);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load links.');
      });
    listSendLinks()
      .then((l) => {
        if (!cancelled) setSendLinks(l);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setSendError(err instanceof Error ? err.message : 'Failed to load send links.');
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
    <>
      <SubNav
        title="Dashboard"
        actions={
          <>
            <Link to="/links/receive/new" className="btn-primary">
              New receive link
            </Link>
            <Link to="/links/send/new" className="btn-secondary-pill">
              New send link
            </Link>
          </>
        }
      />

      <div className="stack-airy">
        <div className="row between">
          <span className="small muted">
            Signed in as <strong>{displayName}</strong>
          </span>
          <button type="button" className="text-link" onClick={onSignOut}>
            Sign out
          </button>
        </div>

        <section className="stack">
          <h2>Receive links</h2>

          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}

          {links === null && error === null && <p className="muted">Loading…</p>}

          {links !== null && links.length === 0 && (
            <div className="store-card" style={{ alignItems: 'center', textAlign: 'center' }}>
              <p className="lead-airy">No receive links yet.</p>
              <Link to="/links/receive/new" className="btn-primary">
                Create your first receive link
              </Link>
            </div>
          )}

          {links !== null && links.length > 0 && (
            <div className="store-card-grid">
              {links.map((link) => (
                <div key={link.id} className="store-card">
                  <div className="stack-tight">
                    <span className="body-strong">{link.label}</span>
                    <span className="small muted">
                      Code <code>{link.code}</code>
                    </span>
                  </div>
                  <StatusBadge status={link.displayStatus} />
                  {link.maxUploads !== null && (
                    <span className="small muted">{link.maxUploads} upload cap</span>
                  )}
                  <div className="row">
                    <Link to={`/links/receive/${link.id}`} className="text-link">
                      Open
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="stack">
          <h2>Send links</h2>

          {sendError !== null && (
            <p role="alert" className="error">
              {sendError}
            </p>
          )}

          {sendLinks === null && sendError === null && <p className="muted">Loading…</p>}

          {sendLinks !== null && sendLinks.length === 0 && (
            <div className="store-card" style={{ alignItems: 'center', textAlign: 'center' }}>
              <p className="lead-airy">No send links yet.</p>
              <Link to="/links/send/new" className="btn-primary">
                Create your first send link
              </Link>
            </div>
          )}

          {sendLinks !== null && sendLinks.length > 0 && (
            <div className="store-card-grid">
              {sendLinks.map((link) => {
                const remaining =
                  link.maxDownloads !== null
                    ? Math.max(0, link.maxDownloads - link.downloadCount)
                    : null;
                return (
                  <div key={link.id} className="store-card">
                    <div className="stack-tight">
                      <span className="body-strong">{link.label}</span>
                      <span className="small muted">
                        Code <code>{link.code}</code>
                      </span>
                    </div>
                    <StatusBadge status={link.displayStatus} />
                    {remaining !== null && (
                      <span className="small muted">
                        {remaining} of {link.maxDownloads} downloads remaining
                      </span>
                    )}
                    <div className="row">
                      <Link to={`/links/send/${link.id}`} className="text-link">
                        Open
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
