import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { fetchUnreadNotificationCount } from '../lib/api.js';

/**
 * Admin-shell notification bell. Polls `GET /api/notifications` every 30s for
 * the unread count and re-fetches on window focus (cheap, and feels much
 * better than waiting 30s after returning to the tab).
 *
 * Polling is unconditional while the component is mounted — no SSE / WS in
 * v1 per PRD. The endpoint is gated by `requireAdmin`; an expired session
 * just returns 401 which silently zeros the badge until the next focus.
 *
 * The bell itself is a router `<Link>` to `/notifications` rather than a
 * dropdown. Simpler, doesn't need outside-click handling, and the page can
 * own its own data lifecycle.
 *
 * DESIGN.md grammar: a 44×44 `btn-icon-circular` rendered in the global-nav
 * right-cluster. Unread state is signalled by a small Action Blue dot at the
 * top-right corner — the system has no count chip and no second accent.
 */
const POLL_INTERVAL_MS = 30_000;

export function NotificationBell(): JSX.Element {
  const [unread, setUnread] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      fetchUnreadNotificationCount()
        .then((count) => {
          if (!cancelled) setUnread(count);
        })
        .catch(() => {
          // Quietly swallow — a transient 401/500 shouldn't blank the badge.
          // The next successful tick will correct it.
        });
    };

    tick();
    const interval = window.setInterval(tick, POLL_INTERVAL_MS);
    const onFocus = (): void => tick();
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const label = unread === 0 ? 'Notifications' : `Notifications (${unread} unread)`;

  return (
    <Link
      to="/notifications"
      className="btn-icon-circular notification-bell"
      aria-label={label}
      style={{ position: 'relative' }}
    >
      <BellIcon />
      {unread > 0 && <span className="unread-dot" aria-hidden />}
    </Link>
  );
}

function BellIcon(): JSX.Element {
  // 18×18 outline glyph; near-black ink in light mode, white in dark via
  // currentColor (the parent .btn-icon-circular sets color: var(--color-ink)
  // which inverts to white via the dark-mode token block).
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
