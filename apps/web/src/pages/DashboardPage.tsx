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
              <PlusGlyph />
              New receive link
            </Link>
            <Link to="/links/send/new" className="btn-secondary-pill">
              <PlusGlyph />
              New send link
            </Link>
          </>
        }
      />

      <div className="stack-airy">
        <div className="dashboard-signed-in fine-print">
          <span>
            Signed in as <strong>{displayName}</strong>
          </span>
          <span aria-hidden>·</span>
          <button type="button" className="text-link" onClick={onSignOut}>
            Sign out
          </button>
        </div>

        <section className="stack">
          <h2>Receive links</h2>
          <p className="dashboard-section-intro lead-airy">
            Mint a one-time URL so somebody can upload to your bucket.
          </p>

          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}

          {links === null && error === null && <p className="muted">Loading…</p>}

          {links !== null && links.length === 0 && (
            <div className="store-card dashboard-empty">
              <InboxIcon />
              <p className="dashboard-empty-headline lead-airy">No receive links yet.</p>
              <Link to="/links/receive/new" className="btn-primary">
                <PlusGlyph />
                Create your first receive link
              </Link>
            </div>
          )}

          {links !== null && links.length > 0 && (
            <div className="store-card-grid">
              {links.map((link) => (
                <div key={link.id} className="store-card">
                  <span className="dashboard-card-label">{link.label}</span>
                  <span className="dashboard-card-code">
                    Code <code>{link.code}</code>
                  </span>
                  <div>
                    <StatusBadge status={link.displayStatus} />
                  </div>
                  {link.maxUploads !== null && (
                    <span className="dashboard-card-quota">{link.maxUploads} upload cap</span>
                  )}
                  <div className="row">
                    <Link to={`/links/receive/${link.id}`} className="dashboard-card-action">
                      Open <span aria-hidden>→</span>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="stack">
          <h2>Send links</h2>
          <p className="dashboard-section-intro lead-airy">
            Share files with one or more recipients.
          </p>

          {sendError !== null && (
            <p role="alert" className="error">
              {sendError}
            </p>
          )}

          {sendLinks === null && sendError === null && <p className="muted">Loading…</p>}

          {sendLinks !== null && sendLinks.length === 0 && (
            <div className="store-card dashboard-empty">
              <AnchorIcon />
              <p className="dashboard-empty-headline lead-airy">No send links yet.</p>
              <Link to="/links/send/new" className="btn-primary">
                <PlusGlyph />
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
                    <span className="dashboard-card-label">{link.label}</span>
                    <span className="dashboard-card-code">
                      Code <code>{link.code}</code>
                    </span>
                    <div>
                      <StatusBadge status={link.displayStatus} />
                    </div>
                    {remaining !== null && (
                      <span className="dashboard-card-quota">
                        {remaining} of {link.maxDownloads} downloads remaining
                      </span>
                    )}
                    <div className="row">
                      <Link to={`/links/send/${link.id}`} className="dashboard-card-action">
                        Open <span aria-hidden>→</span>
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

/**
 * 12px plus glyph used inside SubNav CTAs and empty-state CTAs. currentColor
 * + 1.75 stroke matches the bell + anchor glyphs so the whole chassis reads
 * as one icon family.
 */
function PlusGlyph(): JSX.Element {
  return (
    <svg
      className="btn-glyph"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

/**
 * Receive-empty-state inbox glyph. 28px, muted ink, matches the rest of the
 * icon family.
 */
function InboxIcon(): JSX.Element {
  return (
    <svg
      className="dashboard-empty-icon"
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

/**
 * Send-empty-state anchor glyph. Mirrors the global-nav brand mark at a
 * larger size — the chassis's repeated motif.
 */
function AnchorIcon(): JSX.Element {
  return (
    <svg
      className="dashboard-empty-icon"
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="5" r="2" />
      <line x1="12" y1="7" x2="12" y2="21" />
      <line x1="8" y1="11" x2="16" y2="11" />
      <path d="M4 14c0 4 3.5 7 8 7s8-3 8-7" />
    </svg>
  );
}
