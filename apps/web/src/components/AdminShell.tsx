import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import '../styles/polish-admin.css';
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
          <div className="global-nav-left">
            <Link to="/" className="brand global-nav-brand">
              <AnchorMark />
              <span>File Harbor</span>
            </Link>
            <Link to="/" className="global-nav-dashboard-link">
              Dashboard
            </Link>
          </div>
          <div className="global-nav-right">
            <NotificationBell />
          </div>
        </div>
      </header>
      <main className="admin-main">{children}</main>
      <AdminFooter />
    </div>
  );
}

/**
 * Tiny anchor glyph that sits to the left of the File Harbor wordmark.
 * 14px, currentColor, stroke 1.75 — matches the bell's stroke weight and the
 * nav-link voice. Inline SVG, no external asset.
 */
function AnchorMark(): JSX.Element {
  return (
    <svg
      className="global-nav-brand-mark"
      width="14"
      height="14"
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
