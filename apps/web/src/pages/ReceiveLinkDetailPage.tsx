import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { getReceiveLink, type FileRecord, type ReceiveLink } from '../lib/api.js';

/**
 * Receive link detail. Shows the shareable URL (with a copy button), the
 * policy summary (password / quota / expiry), and lists the files that have
 * landed via this link.
 *
 * Expiries are stored as UTC epoch seconds and rendered here in viewer-local
 * time — `toLocaleString()` uses the browser's locale and timezone by default.
 */
export function ReceiveLinkDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';
  const [data, setData] = useState<{
    link: ReceiveLink;
    files: FileRecord[];
    uploadsSoFar: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      // Clipboard API can fail in HTTP / iframes. The URL is still in the
      // text input — fall back to "select manually".
      setCopied(false);
    }
  };

  return (
    <main className="page wide">
      <header className="row between">
        <h1>Receive link</h1>
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
              <div>{data.link.status}</div>
            </div>
            <div>
              <div className="muted small">Password</div>
              <div>{data.link.passwordProtected ? 'Protected' : 'None'}</div>
            </div>
            <div>
              <div className="muted small">Uploads</div>
              <div>
                {data.uploadsSoFar}
                {data.link.maxUploads !== null ? ` used / ${data.link.maxUploads} max` : ' (unlimited)'}
              </div>
            </div>
            <div>
              <div className="muted small">Expires</div>
              <div>{formatExpiry(data.link.expiresAt)}</div>
            </div>
          </section>

          <section className="stack">
            <h2>Received files</h2>
            {data.files.length === 0 && <p className="muted">No files yet.</p>}
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
 * Render an expiry timestamp. Includes the timezone abbreviation so the
 * operator isn't left guessing which zone the displayed time refers to —
 * common foot-gun when sharing a link across continents.
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
