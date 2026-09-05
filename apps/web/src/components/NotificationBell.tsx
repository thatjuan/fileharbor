import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { fetchUnreadNotificationCount } from '../lib/api.js';
import { BellIcon } from './Icons.js';

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
 * Rendered as a `btn-icon` in the top-nav right cluster. Unread state is a
 * small accent dot in the corner — the console has no count chip, because the
 * exact number of unread items is never the thing the operator acts on.
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
    <Link to="/notifications" className="btn-icon" aria-label={label}>
      <BellIcon size={16} />
      {unread > 0 && <span className="unread-dot" aria-hidden />}
    </Link>
  );
}
