import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { NotificationBell } from './NotificationBell.js';

/**
 * Thin chrome wrapper for authed admin pages. Renders a top bar containing
 * the brand link and the notification bell, then the page content beneath.
 *
 * Scoped to authed routes (mounted inside `RequireAuth`) so the bell never
 * polls on `/login`, `/setup`, or the public `/r|/s/:code` pages — those
 * surfaces have no admin session and don't need the noise.
 */
export function AdminShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <>
      <nav className="admin-nav">
        <Link to="/" className="brand">
          File Harbor
        </Link>
        <NotificationBell />
      </nav>
      {children}
    </>
  );
}
