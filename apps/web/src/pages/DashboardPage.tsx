import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { FileDropOverlay } from '../components/FileDropOverlay.js';
import { DownloadIcon, InboxIcon, PlusIcon, UploadIcon } from '../components/Icons.js';
import { useLinks } from '../components/LinksProvider.js';
import { StatusBadge } from '../components/StatusBadge.js';
import type { ReceiveLink, ReceiveLinkDisplayStatus, SendLink } from '../lib/api.js';
import type { NewSendLinkLocationState } from '../lib/new-send-link-state.js';
import { useFileDropZone } from '../lib/useFileDropZone.js';

/**
 * Admin dashboard at `/`. The single inventory of every link on the instance.
 *
 * Receive and send links share one table rather than sitting in two sections:
 * the operator's question is almost always "what is the state of link X",
 * not "show me one kind". The direction chip in the first column carries the
 * receive/send split, colour-coded so a mixed list is readable without
 * reading the word.
 *
 * Rows are read-only here. Every per-link action (copy URL, disable, revoke,
 * per-file work) lives on the detail screen, which stays the single place
 * where a link can be changed.
 *
 * Filtering is driven by `?status=` in the URL, written by the rail. Data
 * comes from `LinksProvider` — the shell already loaded it for the rail.
 *
 * The whole window is a file drop target (#65): dropping files jumps to the
 * new-send-link form with those files pre-attached. The dashboard never
 * uploads anything itself; the form owns the whole pipeline.
 */
type Row = { kind: 'receive'; link: ReceiveLink } | { kind: 'send'; link: SendLink };

export function DashboardPage(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { receive, send, receiveError, sendError } = useLinks();

  const drop = useFileDropZone({
    onFiles: (dropped) => {
      // A folder-only drop still lands on the form so it can explain why
      // nothing was attached. A drop with nothing usable is ignored.
      if (dropped.files.length === 0 && dropped.foldersSkipped === 0) return;
      navigate('/links/send/new', { state: dropped satisfies NewSendLinkLocationState });
    },
  });

  const statusFilter = params.get('status') as ReceiveLinkDisplayStatus | null;
  const loading = receive === null && send === null && receiveError === null && sendError === null;
  const error = receiveError ?? sendError;

  // Newest first. Both link kinds share `createdAt`, so one sort covers both.
  const rows: Row[] = [
    ...(receive ?? []).map((link): Row => ({ kind: 'receive', link })),
    ...(send ?? []).map((link): Row => ({ kind: 'send', link })),
  ]
    .filter((r) => statusFilter === null || r.link.displayStatus === statusFilter)
    .sort((a, b) => b.link.createdAt - a.link.createdAt);

  const total = (receive?.length ?? 0) + (send?.length ?? 0);
  const isEmpty = !loading && total === 0;

  return (
    <>
      <FileDropOverlay
        active={drop.isDragging}
        headline="Drop to create a send link"
        itemCount={drop.itemCount}
      />

      <div className="page-head">
        <div className="page-head-text">
          <h1>Links</h1>
          <p className="page-head-sub">
            {statusFilter === null
              ? 'Every receive and send link on this instance.'
              : `Links filtered to ${STATUS_LABELS[statusFilter]}.`}
          </p>
        </div>
        <div className="page-head-actions">
          <Link to="/links/receive/new" className="btn btn-accent">
            <PlusIcon size={13} />
            New receive link
          </Link>
          <Link to="/links/send/new" className="btn btn-ghost">
            <PlusIcon size={13} />
            New send link
          </Link>
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

      {isEmpty ? (
        <EmptyInventory />
      ) : (
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">
              {statusFilter === null ? 'All links' : STATUS_LABELS[statusFilter]}
              <span className="panel-count">{loading ? '—' : rows.length}</span>
            </span>
            {statusFilter !== null && (
              <Link to="/" className="text-link small">
                Clear filter
              </Link>
            )}
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Code</th>
                <th>Label</th>
                <th>Status</th>
                <th>Quota</th>
                <th>Expires</th>
                <th>Created</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr className="data-table-message">
                  <td colSpan={8}>Loading…</td>
                </tr>
              )}

              {!loading && rows.length === 0 && (
                <tr className="data-table-message">
                  <td colSpan={8}>
                    No links match this filter.{' '}
                    <Link to="/" className="text-link">
                      Show all links
                    </Link>
                  </td>
                </tr>
              )}

              {rows.map((row) => (
                <LinkRow key={`${row.kind}-${row.link.id}`} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const STATUS_LABELS: Record<ReceiveLinkDisplayStatus, string> = {
  active: 'Active links',
  disabled: 'Disabled links',
  expired: 'Expired links',
  quota_exhausted: 'Quota-exhausted links',
};

function LinkRow({ row }: { row: Row }): JSX.Element {
  const { kind, link } = row;
  const href = `/links/${kind}/${link.id}`;

  return (
    <tr>
      <td>
        <span className={`chip chip-${kind}`}>
          {kind === 'receive' ? <DownloadIcon size={11} /> : <UploadIcon size={11} />}
          {kind}
        </span>
      </td>
      <td>
        <code className="cell-code">{link.code}</code>
      </td>
      <td className="cell-strong">{link.label}</td>
      <td>
        <StatusBadge status={link.displayStatus} />
      </td>
      <td className="num">{formatQuota(row)}</td>
      <td className="num">{formatExpiry(link.expiresAt)}</td>
      <td className="num">{formatDate(link.createdAt)}</td>
      <td className="cell-actions">
        <Link to={href} className="text-link small">
          Open <span aria-hidden>→</span>
        </Link>
      </td>
    </tr>
  );
}

function EmptyInventory(): JSX.Element {
  return (
    <div className="panel">
      <div className="empty">
        <InboxIcon size={30} className="empty-icon" />
        <p className="empty-title">No links yet</p>
        <p className="empty-hint">
          A receive link lets somebody upload files to you. A send link bundles files into a URL you
          share. Create either to get started — or drop files anywhere on this page.
        </p>
        <div className="row" style={{ marginTop: 'var(--space-xs)' }}>
          <Link to="/links/receive/new" className="btn btn-accent">
            <PlusIcon size={13} />
            New receive link
          </Link>
          <Link to="/links/send/new" className="btn btn-ghost">
            <PlusIcon size={13} />
            New send link
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * The quota column reads differently per direction, because the two links
 * count different things and the list endpoint returns different fields.
 * Receive links expose only the cap (uploads so far is a detail-screen
 * query); send links carry a running download tally, so they can show usage.
 */
function formatQuota(row: Row): string {
  if (row.kind === 'receive') {
    return row.link.maxUploads === null ? 'Unlimited' : `${row.link.maxUploads} upload cap`;
  }
  const { downloadCount, maxDownloads } = row.link;
  return maxDownloads === null
    ? `${downloadCount} downloads`
    : `${downloadCount} / ${maxDownloads}`;
}

/** Short date. The detail screen is where full timestamps belong. */
function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

function formatExpiry(epochSeconds: number | null): string {
  if (epochSeconds === null) return 'Never';
  return formatDate(epochSeconds);
}
