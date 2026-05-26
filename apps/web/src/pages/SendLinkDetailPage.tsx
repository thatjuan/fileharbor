import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { StatusBadge } from '../components/StatusBadge.js';
import { SubNav } from '../components/SubNav.js';
import {
  deleteSendLink,
  getSendLink,
  updateSendLinkStatus,
  type FileRecord,
  type SendLink,
} from '../lib/api.js';

/**
 * Send link detail. Shows the shareable URL (with a copy button), the file(s)
 * the admin packaged into the link, and policy summary fields.
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

  const shareableUrl =
    data && typeof window !== 'undefined' ? `${window.location.origin}/s/${data.link.code}` : '';

  const onCopy = async (): Promise<void> => {
    if (!shareableUrl) return;
    try {
      await navigator.clipboard.writeText(shareableUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const onToggleStatus = async (): Promise<void> => {
    if (!data) return;
    const next = data.link.status === 'active' ? 'disabled' : 'active';
    setBusy(true);
    setActionError(null);
    try {
      const updated = await updateSendLinkStatus(data.link.id, next);
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

  const title = data ? data.link.label : 'Send link';
  const remainingDownloads =
    data && data.link.maxDownloads !== null
      ? Math.max(0, data.link.maxDownloads - data.link.downloadCount)
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
                  {data.link.maxDownloads !== null
                    ? `${data.link.downloadCount} of ${data.link.maxDownloads} downloads used${
                        remainingDownloads !== null ? ` · ${remainingDownloads} remaining` : ''
                      }`
                    : `${data.link.downloadCount} downloads · unlimited`}
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
              {data.files.length === 0 && (
                // The link is created the moment the admin POSTs `/api/send-links`,
                // but the file row only appears after the finalize call returns.
                // If the user navigates here mid-upload (or the upload failed),
                // they'll see this — and Revoke above is the recovery path.
                <p className="muted">No files yet. The upload may still be finalizing.</p>
              )}
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
                          Added {new Date(file.createdAt * 1000).toLocaleString()}
                        </span>
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
