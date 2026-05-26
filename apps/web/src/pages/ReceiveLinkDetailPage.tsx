import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { StatusBadge } from '../components/StatusBadge.js';
import { SubNav } from '../components/SubNav.js';
import {
  deleteFile,
  deleteReceiveLink,
  getFileDownload,
  getReceiveLink,
  updateReceiveLinkStatus,
  type FileRecord,
  type ReceiveLink,
} from '../lib/api.js';

/**
 * Receive link detail. Shows the shareable URL (with a copy button), the
 * policy summary (password / quota / expiry), and lists the files that have
 * landed via this link.
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

  const shareableUrl =
    data && typeof window !== 'undefined' ? `${window.location.origin}/r/${data.link.code}` : '';

  const onCopy = async (): Promise<void> => {
    if (!shareableUrl) return;
    try {
      await navigator.clipboard.writeText(shareableUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail in HTTP / iframes. The shareable URL is still
      // visible in the <code> next to the button — operators can select it
      // manually as the fallback.
      setCopied(false);
    }
  };

  const onToggleStatus = async (): Promise<void> => {
    if (!data) return;
    const next = data.link.status === 'active' ? 'disabled' : 'active';
    setBusy(true);
    setActionError(null);
    try {
      const updated = await updateReceiveLinkStatus(data.link.id, next);
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

  const title = data ? data.link.label : 'Receive link';
  const remainingUses =
    data && data.link.maxUploads !== null
      ? Math.max(0, data.link.maxUploads - data.uploadsSoFar)
      : null;

  return (
    <>
      <SubNav
        title={title}
        actions={
          <Link to="/" className="text-link">
            Back to dashboard
          </Link>
        }
      />
      <div className="container-narrow stack-airy">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        {!data && !error && <p className="muted">Loading…</p>}

        {data && (
          <>
            <section className="stack-airy">
              <h1>{data.link.label}</h1>

              <div className="row">
                <code>{shareableUrl}</code>
                <button
                  type="button"
                  className="btn-icon-circular"
                  aria-label={copied ? 'Copied' : 'Copy URL'}
                  onClick={() => void onCopy()}
                >
                  <CopyIcon />
                </button>
              </div>

              <div className="row">
                <StatusBadge status={data.link.displayStatus} />
                <span className="small muted">
                  {data.link.maxUploads !== null
                    ? `${data.uploadsSoFar} of ${data.link.maxUploads} uploads used${
                        remainingUses !== null ? ` · ${remainingUses} remaining` : ''
                      }`
                    : `${data.uploadsSoFar} uploads · unlimited`}
                </span>
                <span className="small muted">
                  {data.link.passwordProtected ? 'Password protected' : 'No password'}
                </span>
                <span className="small">Expires {formatExpiry(data.link.expiresAt)}</span>
              </div>

              <div className="row">
                <button
                  type="button"
                  className="btn-secondary-pill"
                  onClick={() => void onToggleStatus()}
                  disabled={busy}
                >
                  {data.link.status === 'active' ? 'Disable' : 'Re-enable'}
                </button>
                <button
                  type="button"
                  className="btn-secondary-pill"
                  onClick={() => void onDeleteLink()}
                  disabled={busy}
                >
                  Revoke
                </button>
              </div>

              {actionError && (
                <p role="alert" className="error">
                  {actionError}
                </p>
              )}
            </section>

            <section className="stack">
              <h2>Files</h2>
              {data.files.length === 0 && <p className="muted">No files yet.</p>}
              {data.files.length > 0 && (
                <ul className="list-reset stack">
                  {data.files.map((file) => (
                    <li key={file.id} className="store-card-row">
                      <div className="stack-tight">
                        <span className="body-strong">{file.filename}</span>
                        <span className="muted small">
                          {file.contentType} · {formatBytes(file.size)}
                        </span>
                        <span className="small">
                          Uploaded {new Date(file.createdAt * 1000).toLocaleString()}
                        </span>
                      </div>
                      <div className="row">
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => void onDownloadFile(file.id)}
                        >
                          Download
                        </button>
                        <button
                          type="button"
                          className="btn-secondary-pill"
                          onClick={() => void onDeleteFile(file.id, file.filename)}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}

function CopyIcon(): JSX.Element {
  // 18×18 outline copy glyph; inherits `currentColor` from the parent
  // `.btn-icon-circular` (ink in light mode, white in dark via tokens).
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
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
