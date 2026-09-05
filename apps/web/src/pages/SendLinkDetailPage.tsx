import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  ArrowLeftIcon,
  CopyIcon,
  FileIcon,
  InboxIcon,
  TrashIcon,
  UploadIcon,
} from '../components/Icons.js';
import { StatusBadge } from '../components/StatusBadge.js';
import {
  deleteSendLink,
  getSendLink,
  updateSendLink,
  type FileRecord,
  type SendLink,
} from '../lib/api.js';

/**
 * Send link detail. Shows the shareable URL (with a copy button), the policy
 * summary (status / download quota / password / expiry) as a meta strip, and
 * the files the admin packaged into the link.
 *
 * Deliberately the mirror image of `ReceiveLinkDetailPage`: same order, same
 * blocks, same wording. The files table has no per-row actions here — a send
 * link's bundle is fixed at creation time.
 *
 * Admin actions (#12):
 *   - Disable / Re-enable the link (toggles `status`).
 *   - Delete the link (bundled files survive — they orphan to
 *     `send_link_id = NULL` and remain reachable at `/api/files/:id`; the
 *     S3 bytes are untouched).
 */
export function SendLinkDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const id = params.id ?? '';
  const [data, setData] = useState<{ link: SendLink; files: FileRecord[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getSendLink(id)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load.');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const shareTail = data ? `/s/${data.link.code}` : '';
  const shareableUrl = data && origin ? `${origin}${shareTail}` : '';

  const onCopy = async (): Promise<void> => {
    if (!shareableUrl) return;
    try {
      await navigator.clipboard.writeText(shareableUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail in HTTP / iframes. The shareable URL is still
      // visible in the `.share-url` next to the button — operators can select
      // it manually as the fallback.
      setCopied(false);
    }
  };

  const onToggleStatus = async (): Promise<void> => {
    if (!data) return;
    const next = data.link.status === 'active' ? 'disabled' : 'active';
    setBusy(true);
    setActionError(null);
    try {
      const updated = await updateSendLink(data.link.id, { status: next });
      setData({ ...data, link: updated });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update link.');
    } finally {
      setBusy(false);
    }
  };

  const onDeleteLink = async (): Promise<void> => {
    if (!data) return;
    if (
      !window.confirm(
        'Delete this send link? The bundled files will be kept (admin only), but the code will stop working.',
      )
    ) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await deleteSendLink(data.link.id);
      navigate('/', { replace: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete link.');
      setBusy(false);
    }
  };

  const maxDownloads = data?.link.maxDownloads ?? null;
  const usedPercent =
    data && maxDownloads !== null && maxDownloads > 0
      ? Math.min(100, Math.round((data.link.downloadCount / maxDownloads) * 100))
      : null;

  return (
    <>
      <Link to="/" className="back-link">
        <ArrowLeftIcon size={13} />
        Back to dashboard
      </Link>

      {error !== null && (
        <p role="alert" className="notice notice-danger">
          {error}
        </p>
      )}

      {data === null && error === null && <p className="muted">Loading…</p>}

      {data !== null && (
        <>
          <div className="page-head">
            <div className="page-head-text">
              <h1>{data.link.label}</h1>
              <p className="page-head-sub">
                <span className="chip chip-send">
                  <UploadIcon size={11} />
                  send
                </span>
                Created {formatDateTime(data.link.createdAt)}
              </p>
            </div>
            <div className="page-head-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void onToggleStatus()}
                disabled={busy}
              >
                {data.link.status === 'active' ? 'Disable' : 'Re-enable'}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void onDeleteLink()}
                disabled={busy}
              >
                <TrashIcon size={13} />
                Revoke
              </button>
            </div>
          </div>

          <div className="share-block">
            <span className="meta-label">Share this link</span>
            <div className="share-row">
              <div className="share-url">
                {origin}
                <span className="share-url-code">{shareTail}</span>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={copied ? 'Copied' : 'Copy URL'}
                onClick={() => void onCopy()}
              >
                <CopyIcon size={13} />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="meta-strip">
            <div className="meta-item">
              <span className="meta-label">Status</span>
              <span className="meta-value">
                <StatusBadge status={data.link.displayStatus} />
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Downloads</span>
              <span className="meta-value">
                {maxDownloads === null
                  ? `${data.link.downloadCount} · unlimited`
                  : `${data.link.downloadCount} of ${maxDownloads}`}
              </span>
              {usedPercent !== null && (
                <div className="progress">
                  <div className="progress-track">
                    <div
                      className={`progress-fill${usedPercent >= 100 ? ' progress-fill-danger' : ''}`}
                      style={{ width: `${usedPercent}%` }}
                    />
                  </div>
                  <span className="meta-sub">{usedPercent}% of the download cap used</span>
                </div>
              )}
            </div>
            <div className="meta-item">
              <span className="meta-label">Password</span>
              <span className="meta-value">
                {data.link.passwordProtected ? 'Enabled' : 'Not set'}
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Expires</span>
              <span className="meta-value">{formatExpiry(data.link.expiresAt)}</span>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">
                Files
                <span className="panel-count">{data.files.length}</span>
              </span>
            </div>

            {data.files.length === 0 ? (
              // The link is created the moment the admin POSTs `/api/send-links`,
              // but the file row only appears after the finalize call returns.
              // If the user navigates here mid-upload (or the upload failed),
              // they'll see this — and Revoke above is the recovery path.
              <div className="empty">
                <InboxIcon size={30} className="empty-icon" />
                <p className="empty-title">No files yet</p>
                <p className="empty-hint">
                  The upload may still be finalizing. If it failed, revoke this link and create a
                  new one.
                </p>
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Size</th>
                    <th>Added</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.files.map((file) => (
                    <tr key={file.id}>
                      <td className="cell-strong">
                        <span className="row">
                          <FileIcon size={13} className="faint" />
                          {file.filename}
                        </span>
                      </td>
                      <td className="muted">{file.contentType}</td>
                      <td className="num">{formatBytes(file.size)}</td>
                      <td className="num">{formatDateTime(file.createdAt)}</td>
                      <td className="cell-actions" />
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {actionError !== null && (
            <p
              role="alert"
              className="notice notice-danger"
              style={{ marginTop: 'var(--space-md)' }}
            >
              {actionError}
            </p>
          )}
        </>
      )}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Local-time timestamp for creation and per-file rows. */
function formatDateTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

/**
 * Mirror of the receive-side `formatExpiry`: includes timezone abbreviation
 * and an "expired" suffix when the timestamp is in the past.
 */
function formatExpiry(epochSeconds: number | null): string {
  if (epochSeconds === null) return 'never';
  const date = new Date(epochSeconds * 1000);
  const tz =
    Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  const expired = date.getTime() <= Date.now();
  return `${date.toLocaleString()}${tz ? ` (${tz})` : ''}${expired ? ' — expired' : ''}`;
}
