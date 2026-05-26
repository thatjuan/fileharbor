import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { SubNav } from '../components/SubNav.js';
import {
  isUploadReceivedPayload,
  listNotifications,
  markNotificationsRead,
  type NotificationRecord,
} from '../lib/api.js';

/**
 * Notifications panel. Lists recent items newest-first; each row shows the
 * timestamp, a human-readable description, and a link to the receive link
 * (for context) plus a download link to the file itself.
 *
 * Read state is managed in two affordances:
 *   - per-row "Mark read" on each unread item
 *   - top-level "Mark all read" bulk button (in SubNav actions, only when
 *     there are unread items — per DESIGN.md affordance density rules).
 *
 * Both call the server and use the response's `unreadCount` to update the
 * local state — no need to recount client-side.
 *
 * No pagination (yet). The default limit of 50 is generous for a single-user
 * instance; a follow-up slice can add load-more if the list grows. The PRD's
 * "recent items" requirement is satisfied by the server-side `limit + desc`.
 */
const DEFAULT_LIMIT = 50;

export function NotificationsPage(): JSX.Element {
  const [items, setItems] = useState<NotificationRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    listNotifications({ limit: DEFAULT_LIMIT })
      .then((data) => {
        if (!cancelled) setItems(data.notifications);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load notifications.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onMarkOne = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await markNotificationsRead({ ids: [id] });
      // Optimistic: flip the row's readAt locally rather than re-fetching.
      // The server is the source of truth; a stale render here just means
      // the next page-load reconciles.
      setItems((prev) =>
        prev === null
          ? prev
          : prev.map((n) => (n.id === id ? { ...n, readAt: Math.floor(Date.now() / 1000) } : n)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark read.');
    } finally {
      setBusy(false);
    }
  };

  const onMarkAll = async (): Promise<void> => {
    setBusy(true);
    try {
      await markNotificationsRead({ all: true });
      const now = Math.floor(Date.now() / 1000);
      setItems((prev) =>
        prev === null ? prev : prev.map((n) => (n.readAt ? n : { ...n, readAt: now })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark all read.');
    } finally {
      setBusy(false);
    }
  };

  const unreadCount = items ? items.filter((n) => n.readAt === null).length : 0;
  const hasUnread = unreadCount > 0;

  return (
    <>
      <SubNav
        title="Notifications"
        actions={
          hasUnread ? (
            <button
              type="button"
              className="btn-secondary-pill"
              onClick={onMarkAll}
              disabled={busy}
            >
              Mark all read
            </button>
          ) : undefined
        }
      />
      <section className="container-narrow stack">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        {items === null && !error && <p className="muted">Loading…</p>}

        {items !== null && items.length === 0 && (
          <div className="store-card" style={{ alignItems: 'center', textAlign: 'center' }}>
            <p className="lead-airy">You&apos;re all caught up.</p>
          </div>
        )}

        {items !== null && items.length > 0 && (
          <ul className="list-reset stack">
            {items.map((n) => (
              <li key={n.id}>
                <NotificationItem item={n} onMarkRead={onMarkOne} disabled={busy} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function NotificationItem({
  item,
  onMarkRead,
  disabled,
}: {
  item: NotificationRecord;
  onMarkRead: (id: string) => void;
  disabled: boolean;
}): JSX.Element {
  const isUnread = item.readAt === null;
  // Discriminate on `kind` so future kinds (e.g. `link_expired`) can land
  // here without an exhaustive rewrite — the default arm prints the kind +
  // raw payload as a fallback rather than crashing.
  let title: JSX.Element;
  let body: JSX.Element | null;
  if (item.kind === 'upload_received' && isUploadReceivedPayload(item.payload)) {
    const p = item.payload;
    title = (
      <span>
        Uploaded {p.filename} ({formatSize(p.size)})
      </span>
    );
    body = (
      <div>
        to{' '}
        <Link to={`/links/receive/${p.receiveLinkId}`} className="text-link">
          {p.receiveLinkLabel}
        </Link>
        {' · '}
        <a href={`/api/files/${encodeURIComponent(p.fileId)}/download`} className="text-link">
          Download file
        </a>
      </div>
    );
  } else {
    title = <span>{item.kind}</span>;
    body = null;
  }

  return (
    <div className={`store-card${isUnread ? ' unread' : ''}`}>
      <div className="row between" style={{ alignItems: 'flex-start', gap: 'var(--space-lg)' }}>
        <div className="stack-tight" style={{ flex: 1, minWidth: 0 }}>
          <div className={isUnread ? 'body-strong' : undefined}>{title}</div>
          {body}
          <div className="small muted">{new Date(item.createdAt * 1000).toLocaleString()}</div>
        </div>
        {isUnread && (
          <button
            type="button"
            className="btn-secondary-pill"
            onClick={() => onMarkRead(item.id)}
            disabled={disabled}
          >
            Mark read
          </button>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
