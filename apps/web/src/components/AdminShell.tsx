import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { AdminFooter } from './AdminFooter.js';
import { NotificationBell } from './NotificationBell.js';

/**
 * Chrome wrapper for authed admin pages. Renders the DESIGN.md `global-nav`
 * (black 44px strip, brand on the left, NotificationBell on the right),
 * page content in a max-width 1440 container, then the admin footer.
 *
 * Sub-nav (`{component.sub-nav-frosted}`) is opt-in per page — pages render
 * a `<SubNav>` themselves so they can supply context-appropriate title and
 * action cluster.
 *
 * Scoped to authed routes (mounted inside `RequireAuth`) so the bell never
 * polls on `/login`, `/setup`, or the public `/r|/s/:code` pages.
 */
export function AdminShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="admin-shell">
      <header className="global-nav">
        <div className="global-nav-inner">
          <Link to="/" className="brand">
            File Harbor
          </Link>
          <NotificationBell />
        </div>
      </header>
      <main className="admin-main">{children}</main>
      <AdminFooter />
    </div>
  );
}
