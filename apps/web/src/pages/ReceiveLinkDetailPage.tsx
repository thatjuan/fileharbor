import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  ArrowLeftIcon,
  CopyIcon,
  DownloadIcon,
  FileIcon,
  InboxIcon,
  TrashIcon,
} from '../components/Icons.js';
import { StatusBadge } from '../components/StatusBadge.js';
import {
  deleteFile,
  deleteReceiveLink,
  getFileDownload,
  getReceiveLink,
  updateReceiveLink,
  type FileRecord,
  type ReceiveLink,
} from '../lib/api.js';

/**
 * Receive link detail. Shows the shareable URL (with a copy button), the
 * policy summary (status / quota / password / expiry) as a meta strip, and
 * lists the files that have landed via this link.
 *
 * Deliberately the mirror image of `SendLinkDetailPage`: same order, same
 * blocks, same wording. The two screens differ only where the data differs
 * (uploads vs downloads, per-file actions vs none), so an operator who learns
 * one has learned both.
 *
 * Admin actions:
 *   - Disable / Re-enable the link (toggles `status`).
 *   - Delete the link (received files survive — they orphan to
 *     `receive_link_id = NULL` and remain reachable at `/api/files/:id`).
 *   - Per-file: Download (presigned GET → browser navigation) and Delete
 *     (S3 object then DB row).
 *
 * Expiries are stored as UTC epoch seconds and rendered here in viewer-local
 * time — `toLocaleString()` uses the browser's locale and timezone by default.
 */
export function ReceiveLinkDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const id = params.id ?? '';
  const [data, setData] = useState<{
    link: ReceiveLink;
    files: FileRecord[];
    uploadsSoFar: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getReceiveLink(id)
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
  const shareTail = data ? `/r/${data.link.code}` : '';
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
      const updated = await updateReceiveLink(data.link.id, { status: next });
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
        'Delete this receive link? Already-uploaded files will be kept (admin only), but the code will stop working.',
      )
    ) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await deleteReceiveLink(data.link.id);
      navigate('/', { replace: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete link.');
      setBusy(false);
    }
  };

  /**
   * Mint a presigned GET and navigate to it. We use `window.location.assign`
   * rather than synthesising an `<a download>`: presigned GETs already sign
   * `response-content-disposition: attachment; filename="..."`, so the
   * browser's default behaviour is exactly the save-with-friendly-name path.
   * A normal navigation keeps the URL inspectable in DevTools for support.
   */
  const onDownloadFile = async (fileId: string): Promise<void> => {
    setActionError(null);
    try {
      const dl = await getFileDownload(fileId);
      window.location.assign(dl.url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to start download.');
    }
  };

  const onDeleteFile = async (fileId: string, filename: string): Promise<void> => {
    if (!data) return;
    if (!window.confirm(`Delete "${filename}"? The S3 object will be removed too.`)) return;
    setActionError(null);
    try {
      await deleteFile(fileId);
      setData({
        ...data,
        files: data.files.filter((f) => f.id !== fileId),
        uploadsSoFar: Math.max(0, data.uploadsSoFar - 1),
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete file.');
    }
  };

  const maxUploads = data?.link.maxUploads ?? null;
  const usedPercent =
    data && maxUploads !== null && maxUploads > 0
      ? Math.min(100, Math.round((data.uploadsSoFar / maxUploads) * 100))
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
                <span className="chip chip-receive">
                  <DownloadIcon size={11} />
                  receive
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
              <span className="meta-label">Uploads</span>
              <span className="meta-value">
                {maxUploads === null
                  ? `${data.uploadsSoFar} · unlimited`
                  : `${data.uploadsSoFar} of ${maxUploads}`}
              </span>
              {usedPercent !== null && (
                <div className="progress">
                  <div className="progress-track">
                    <div
                      className={`progress-fill${usedPercent >= 100 ? ' progress-fill-danger' : ''}`}
                      style={{ width: `${usedPercent}%` }}
                    />
                  </div>
                  <span className="meta-sub">{usedPercent}% of the upload cap used</span>
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
              <div className="empty">
                <InboxIcon size={30} className="empty-icon" />
                <p className="empty-title">No files yet</p>
                <p className="empty-hint">
                  Uploads made through this link will appear here as soon as they finish.
                </p>
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Size</th>
                    <th>Uploaded</th>
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
                      <td className="cell-actions">
                        <button
                          type="button"
                          className="btn-icon-bare btn-icon-bare-accent"
                          aria-label={`Download ${file.filename}`}
                          onClick={() => void onDownloadFile(file.id)}
                        >
                          <DownloadIcon size={13} />
                        </button>
                        <button
                          type="button"
                          className="btn-icon-bare btn-icon-bare-danger"
                          aria-label={`Remove ${file.filename}`}
                          onClick={() => void onDeleteFile(file.id, file.filename)}
                        >
                          <TrashIcon size={13} />
                        </button>
                      </td>
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
 * Render an expiry timestamp. Includes the timezone abbreviation so the
 * operator isn't left guessing which zone the displayed time refers to —
 * common foot-gun when sharing a link across continents.
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
