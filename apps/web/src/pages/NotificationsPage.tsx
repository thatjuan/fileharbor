import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { AlertIcon, BellIcon, UploadIcon } from '../components/Icons.js';
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
 *   - top-level "Mark all read" bulk button (in the page head, only when
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
      <div className="page-head">
        <div className="page-head-text">
          <h1>Notifications</h1>
          <p className="page-head-sub">Recent events on this instance, newest first.</p>
        </div>
        <div className="page-head-actions">
          {hasUnread && (
            <button type="button" className="btn btn-ghost" onClick={onMarkAll} disabled={busy}>
              Mark all read
            </button>
          )}
        </div>
      </div>

      {error !== null && (
        <p
          role="alert"
          className="notice notice-danger"
          style={{ marginBottom: 'var(--space-md)' }}
        >
          {error}
        </p>
      )}

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">
            Activity
            <span className="panel-count">{items === null ? '—' : unreadCount}</span>
          </span>
        </div>

        {items === null && !error && (
          <div className="panel-body">
            <p className="muted">Loading…</p>
          </div>
        )}

        {items !== null && items.length === 0 && (
          <div className="empty">
            <BellIcon size={30} className="empty-icon" />
            <p className="empty-title">All caught up</p>
            <p className="empty-hint">
              Uploads and other instance events land here as they happen. Nothing to read right now.
            </p>
          </div>
        )}

        {items !== null && items.length > 0 && (
          <ul className="list-reset">
            {items.map((n, i) => (
              <li key={n.id}>
                <NotificationItem
                  item={n}
                  onMarkRead={onMarkOne}
                  disabled={busy}
                  isLast={i === items.length - 1}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function NotificationItem({
  item,
  onMarkRead,
  disabled,
  isLast,
}: {
  item: NotificationRecord;
  onMarkRead: (id: string) => void;
  disabled: boolean;
  isLast: boolean;
}): JSX.Element {
  const isUnread = item.readAt === null;
  // Discriminate on `kind` so future kinds (e.g. `link_expired`) can land
  // here without an exhaustive rewrite — the default arm prints the kind +
  // raw payload as a fallback rather than crashing.
  let title: JSX.Element;
  let body: JSX.Element | null;
  let isUpload = false;
  if (item.kind === 'upload_received' && isUploadReceivedPayload(item.payload)) {
    const p = item.payload;
    isUpload = true;
    title = (
      <span>
        Uploaded {p.filename} ({formatSize(p.size)})
      </span>
    );
    body = (
      <div className="small secondary">
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
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-sm)',
        padding: 'var(--space-sm) var(--space-md)',
        borderBottom: isLast ? 'none' : '1px solid var(--color-hairline-soft)',
        background: isUnread ? 'var(--color-surface-raised)' : 'transparent',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: '0 0 auto',
          width: 30,
          height: 30,
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--color-hairline)',
          background: isUpload ? 'var(--color-accent-wash)' : 'var(--color-warning-wash)',
          color: isUpload ? 'var(--color-accent)' : 'var(--color-warning)',
        }}
      >
        {isUpload ? <UploadIcon size={14} /> : <AlertIcon size={14} />}
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className={isUnread ? 'strong' : undefined}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}
        >
          {isUnread && (
            <span
              aria-hidden
              style={{
                flex: '0 0 auto',
                width: 5,
                height: 5,
                borderRadius: 'var(--radius-pill)',
                background: 'var(--color-accent)',
              }}
            />
          )}
          {title}
        </div>
        {body}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          flex: '0 0 auto',
          paddingTop: 2,
        }}
      >
        <span className="small faint">{formatWhen(item.createdAt)}</span>
        {isUnread && (
          <button
            type="button"
            className="text-link small"
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

/** Relative for the last day, absolute after that — an operator scanning the
 * list cares about "how recent", not the exact clock time of last week. */
function formatWhen(epochSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: '2-digit',
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
