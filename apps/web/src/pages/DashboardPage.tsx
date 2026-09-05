import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { FileDropOverlay } from '../components/FileDropOverlay.js';
import { DownloadIcon, InboxIcon, PlusIcon, UploadIcon } from '../components/Icons.js';
import { useLinks } from '../components/LinksProvider.js';
import { StatusBadge } from '../components/StatusBadge.js';
import {
  deleteReceiveLink,
  deleteSendLink,
  updateReceiveLink,
  updateSendLink,
  type ReceiveLink,
  type ReceiveLinkDisplayStatus,
  type SendLink,
} from '../lib/api.js';
import { runBulk } from '../lib/bulk.js';
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
 * Rows are selectable, and a selection turns on a bulk bar with the two
 * actions that are painful one link at a time: delete, and change expiry
 * (#68). Everything else — copy URL, disable, per-file work — still lives on
 * the detail screen. Selection spans both link kinds, and the fan-out sends
 * each row to whichever endpoint it needs.
 *
 * Filtering is driven by `?status=` in the URL, written by the rail. Data
 * comes from `LinksProvider` — the shell already loaded it for the rail, and
 * a bulk action refreshes it so the rail counts don't drift.
 *
 * The whole window is a file drop target (#65): dropping files jumps to the
 * new-send-link form with those files pre-attached. The dashboard never
 * uploads anything itself; the form owns the whole pipeline.
 */
type Row = { kind: 'receive'; link: ReceiveLink } | { kind: 'send'; link: SendLink };

/** Stable identity for a row across refreshes. Ids are unique per kind only. */
function rowKey(row: Row): string {
  return `${row.kind}-${row.link.id}`;
}

export function DashboardPage(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { receive, send, receiveError, sendError, refresh } = useLinks();

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; failed: boolean } | null>(null);

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

  // Selection is against what is on screen. Changing the filter would leave
  // invisible rows selected and a bulk action would hit links the operator
  // can't see, so the filter resets the selection.
  useEffect(() => {
    setSelected(new Set());
    setExpiryOpen(false);
    setOutcome(null);
  }, [statusFilter]);

  const selectedRows = rows.filter((r) => selected.has(rowKey(r)));
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;

  const toggleRow = (row: Row): void => {
    const key = rowKey(row);
    const next = new Set(selected);
    if (!next.delete(key)) next.add(key);
    setSelected(next);
  };

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(rows.map(rowKey)));
  };

  const clearSelection = (): void => {
    setSelected(new Set());
    setExpiryOpen(false);
  };

  /**
   * Fan the per-link call out over the selection and report honestly. Rows
   * that failed stay selected so a retry hits exactly those; the rest of the
   * selection clears because that work is done. A failed row that no longer
   * exists (someone deleted it elsewhere) just disappears on the refresh —
   * which is why the message counts failures rather than claiming what is
   * still on screen.
   */
  const applyBulk = async (verb: string, task: (row: Row) => Promise<unknown>): Promise<void> => {
    const targets = selectedRows;
    if (targets.length === 0) return;
    setBusy(true);
    setOutcome(null);

    const { succeeded, failed } = await runBulk(targets, task);
    refresh();
    setSelected(new Set(failed.map((f) => rowKey(f.item))));
    setBusy(false);
    setExpiryOpen(false);

    if (failed.length === 0) {
      setOutcome({ text: `${plural(succeeded.length)} ${verb}.`, failed: false });
      return;
    }
    setOutcome({
      text:
        `${succeeded.length} of ${targets.length} links ${verb}. ` +
        `${failed.length} failed — first error: ${failed[0]!.message}`,
      failed: true,
    });
  };

  const onBulkDelete = (): void => {
    const receiveCount = selectedRows.filter((r) => r.kind === 'receive').length;
    const sendCount = selectedRows.length - receiveCount;
    if (
      !window.confirm(
        `Delete ${plural(selectedRows.length)} (${receiveCount} receive, ${sendCount} send)? ` +
          'Their codes stop working immediately and any outstanding upload or download ' +
          'tickets are removed. Uploaded and bundled files are kept (admin only).',
      )
    ) {
      return;
    }
    void applyBulk('deleted', (row) =>
      row.kind === 'receive' ? deleteReceiveLink(row.link.id) : deleteSendLink(row.link.id),
    );
  };

  const onBulkExpiry = (expiresAt: number | null): void => {
    void applyBulk('updated', (row) =>
      row.kind === 'receive'
        ? updateReceiveLink(row.link.id, { expiresAt })
        : updateSendLink(row.link.id, { expiresAt }),
    );
  };

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

      {outcome !== null && (
        <p
          role="status"
          className={`notice ${outcome.failed ? 'notice-warning' : ''}`}
          style={{ marginBottom: 'var(--space-md)' }}
        >
          {outcome.text}
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

          {selectedRows.length > 0 && (
            <BulkBar
              count={selectedRows.length}
              busy={busy}
              expiryOpen={expiryOpen}
              onToggleExpiry={() => setExpiryOpen((open) => !open)}
              onDelete={onBulkDelete}
              onApplyExpiry={onBulkExpiry}
              onClear={clearSelection}
            />
          )}

          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '1%' }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allSelected && selectedRows.length > 0;
                    }}
                    onChange={toggleAll}
                    disabled={busy || rows.length === 0}
                    aria-label="Select every link in this view"
                  />
                </th>
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
                  <td colSpan={9}>Loading…</td>
                </tr>
              )}

              {!loading && rows.length === 0 && (
                <tr className="data-table-message">
                  <td colSpan={9}>
                    No links match this filter.{' '}
                    <Link to="/" className="text-link">
                      Show all links
                    </Link>
                  </td>
                </tr>
              )}

              {rows.map((row) => (
                <LinkRow
                  key={rowKey(row)}
                  row={row}
                  selected={selected.has(rowKey(row))}
                  busy={busy}
                  onToggle={() => toggleRow(row)}
                />
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

function plural(count: number): string {
  return `${count} ${count === 1 ? 'link' : 'links'}`;
}

interface BulkBarProps {
  count: number;
  busy: boolean;
  expiryOpen: boolean;
  onToggleExpiry: () => void;
  onDelete: () => void;
  onApplyExpiry: (expiresAt: number | null) => void;
  onClear: () => void;
}

/**
 * The bar that appears under the panel head once something is selected. It
 * reuses the panel-head grammar rather than inventing a floating toolbar:
 * the actions belong to the table below them, and sitting in the same band as
 * the title keeps that relationship obvious.
 */
function BulkBar({
  count,
  busy,
  expiryOpen,
  onToggleExpiry,
  onDelete,
  onApplyExpiry,
  onClear,
}: BulkBarProps): JSX.Element {
  const [when, setWhen] = useState('');
  const [never, setNever] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onApply = (): void => {
    if (never) {
      setFormError(null);
      onApplyExpiry(null);
      return;
    }
    // `datetime-local` hands back local wall time; `Date` parses it in the
    // viewer's zone, which is what the operator meant. The API wants UTC
    // epoch seconds.
    const parsed = new Date(when).getTime();
    if (when === '' || Number.isNaN(parsed)) {
      setFormError('Pick a date and time, or choose "never expires".');
      return;
    }
    setFormError(null);
    onApplyExpiry(Math.floor(parsed / 1000));
  };

  return (
    <>
      <div className="panel-head">
        <span className="panel-title">{plural(count)} selected</span>
        <div className="row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onToggleExpiry}
            disabled={busy}
            aria-expanded={expiryOpen}
          >
            Change expiry
          </button>
          <button type="button" className="btn btn-danger" onClick={onDelete} disabled={busy}>
            Delete
          </button>
          <button type="button" className="text-link small" onClick={onClear} disabled={busy}>
            Clear selection
          </button>
        </div>
      </div>

      {expiryOpen && (
        <div className="panel-head">
          <div className="row">
            <input
              type="datetime-local"
              className="input"
              style={{ width: 'auto' }}
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              disabled={busy || never}
              aria-label="New expiry"
            />
            <label className="row" style={{ gap: 'var(--space-xxs)' }}>
              <input
                type="checkbox"
                checked={never}
                onChange={(e) => setNever(e.target.checked)}
                disabled={busy}
              />
              Never expires
            </label>
          </div>
          <div className="row">
            {formError !== null && (
              <span role="alert" className="small" style={{ color: 'var(--color-danger)' }}>
                {formError}
              </span>
            )}
            <button type="button" className="btn btn-accent" onClick={onApply} disabled={busy}>
              {busy ? 'Applying…' : `Apply to ${plural(count)}`}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

interface LinkRowProps {
  row: Row;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
}

function LinkRow({ row, selected, busy, onToggle }: LinkRowProps): JSX.Element {
  const { kind, link } = row;
  const href = `/links/${kind}/${link.id}`;

  return (
    <tr>
      <td>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={busy}
          aria-label={`Select ${kind} link ${link.code}`}
        />
      </td>
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
