import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { signOut, useSession } from '../lib/auth-client.js';
import { AnchorIcon } from './Icons.js';
import { LinksProvider } from './LinksProvider.js';
import { NotificationBell } from './NotificationBell.js';
import { Rail } from './Rail.js';

/**
 * Chrome for every authed screen: a slim top nav, the left rail, and the
 * scrolling workspace between them.
 *
 * The nav and rail are fixed; only `.workspace` scrolls. That is the point of
 * the layout — the operator keeps the link counts and the create actions in
 * view while reading a long table.
 *
 * Mounted inside `RequireAuth`, so the bell never polls and the rail never
 * fetches on `/login`, `/setup`, or the public pages.
 */
export function AdminShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <LinksProvider>
      <div className="app-shell">
        <TopNav />
        <Rail />
        <main className="workspace">
          <div className="workspace-body">{children}</div>
          <Footer />
        </main>
      </div>
    </LinksProvider>
  );
}

function TopNav(): JSX.Element {
  const { data: session } = useSession();
  const navigate = useNavigate();

  // better-auth's username plugin surfaces the display name under a couple of
  // keys depending on how the account was created; fall back through them.
  const displayName =
    (session?.user as { displayUsername?: string | null } | undefined)?.displayUsername ??
    (session?.user as { username?: string | null } | undefined)?.username ??
    session?.user?.name ??
    'admin';

  const onSignOut = async (): Promise<void> => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <header className="top-nav">
      <div className="top-nav-inner">
        <div className="top-nav-left">
          <Link to="/" className="top-nav-brand">
            <AnchorIcon size={16} className="top-nav-brand-mark" />
            File Harbor
          </Link>
        </div>
        <div className="top-nav-right">
          <span className="top-nav-identity">
            <span className="top-nav-identity-dot" aria-hidden />
            {displayName}
          </span>
          <button type="button" className="text-link small" onClick={() => void onSignOut()}>
            Sign out
          </button>
          <NotificationBell />
        </div>
      </div>
    </header>
  );
}

function Footer(): JSX.Element {
  return (
    <footer className="app-footer">
      <span>File Harbor — self-hosted file send / receive. MIT licensed.</span>
      <span className="row">
        <a href="https://github.com/thatjuan/fileharbor" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <a href="https://github.com/thatjuan/fileharbor/issues" target="_blank" rel="noreferrer">
          Report an issue
        </a>
      </span>
    </footer>
  );
}
