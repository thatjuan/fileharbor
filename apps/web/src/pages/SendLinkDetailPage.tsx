import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { StatusBadge } from '../components/StatusBadge.js';
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

  return (
    <main className="page wide">
      <header className="row between">
        <h1>Send link</h1>
        <Link to="/">Back</Link>
      </header>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {!data && !error && <p className="muted">Loading…</p>}

      {data && (
        <>
          <section className="stack">
            <div>
              <div className="muted small">Label</div>
              <div>
                <strong>{data.link.label}</strong>
              </div>
            </div>
            <div>
              <div className="muted small">Shareable URL</div>
              <div className="row">
                <input
                  type="text"
                  readOnly
                  value={shareableUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{ flex: 1 }}
                />
                <button type="button" onClick={onCopy}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div>
              <div className="muted small">Status</div>
              <div className="row">
                <StatusBadge status={data.link.displayStatus} />
              </div>
            </div>
            <div>
              <div className="muted small">Password</div>
              <div>{data.link.passwordProtected ? 'Protected' : 'None'}</div>
            </div>
            <div>
              <div className="muted small">Downloads</div>
              <div>
                {data.link.downloadCount}
                {data.link.maxDownloads !== null
                  ? ` used / ${data.link.maxDownloads} max`
                  : ' (unlimited)'}
              </div>
            </div>
            <div>
              <div className="muted small">Expires</div>
              <div>{formatExpiry(data.link.expiresAt)}</div>
            </div>

            <div className="row">
              <button type="button" onClick={onToggleStatus} disabled={busy}>
                {data.link.status === 'active' ? 'Disable link' : 'Re-enable link'}
              </button>
              <button
                type="button"
                onClick={onDeleteLink}
                disabled={busy}
                className="button-danger"
              >
                Delete link
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
              // they'll see this — and the Delete-link button above is the
              // recovery path.
              <p className="muted">No files yet. The upload may still be finalizing.</p>
            )}
            {data.files.length > 0 && (
              <ul className="list-reset stack">
                {data.files.map((file) => (
                  <li key={file.id} className="card">
                    <div>
                      <strong>{file.filename}</strong>
                    </div>
                    <div className="muted small">
                      {formatBytes(file.size)} · {file.contentType} ·{' '}
                      {new Date(file.createdAt * 1000).toLocaleString()}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
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
  if (epochSeconds === null) return 'Never';
  const date = new Date(epochSeconds * 1000);
  const tz =
    Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  const expired = date.getTime() <= Date.now();
  return `${date.toLocaleString()}${tz ? ` (${tz})` : ''}${expired ? ' — expired' : ''}`;
}
