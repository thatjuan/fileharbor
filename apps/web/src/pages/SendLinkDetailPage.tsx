import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { StatusBadge } from '../components/StatusBadge.js';
import { getSendLink, type FileRecord, type SendLink } from '../lib/api.js';

/**
 * Send link detail. Shows the shareable URL (with a copy button), the file(s)
 * the admin packaged into the link, and policy summary fields. For this slice
 * there are no actions — disable / re-enable / delete is #12, and adding more
 * files to an existing link is #11.
 */
export function SendLinkDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';
  const [data, setData] = useState<{ link: SendLink; files: FileRecord[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
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
              <div className="muted small">Downloads</div>
              <div>
                {data.link.downloadCount}
                {data.link.maxDownloads !== null
                  ? ` used / ${data.link.maxDownloads} max`
                  : ' (unlimited)'}
              </div>
            </div>
          </section>

          <section className="stack">
            <h2>Files</h2>
            {data.files.length === 0 && (
              // The link is created the moment the admin POSTs `/api/send-links`,
              // but the file row only appears after the finalize call returns.
              // If the user navigates here mid-upload (or the upload failed),
              // they'll see this — the situation is recoverable in #12 with a
              // delete button.
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
