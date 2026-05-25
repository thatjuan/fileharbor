import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import {
  createDownloadTicket,
  getPublicSendLink,
  type PolicyRejection,
  type PublicSendLink,
} from '../lib/api.js';

/**
 * Public download page (`/s/:code`). Unauthenticated. Lists the files in the
 * send link and, on the recipient clicking Download, mints a presigned GET
 * server-side and navigates the browser to it. The file lands directly from
 * S3 (Content-Disposition: attachment) with the friendly filename — File
 * Harbor never touches the bytes.
 *
 * In #8 the link has exactly one file; the page still iterates a list so it
 * stays correct when #11 introduces bundles. Password / quota / expiry are
 * also #11 — for now `passwordRequired` is always false on the wire, but the
 * rejection handler is wired for symmetry with the receive flow.
 */
export function PublicSendPage(): JSX.Element {
  const params = useParams<{ code: string }>();
  const code = params.code ?? '';

  const [meta, setMeta] = useState<PublicSendLink | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPublicSendLink(code)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setMetaError(err instanceof Error ? err.message : 'Link not found or disabled.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const onDownload = async (fileId: string): Promise<void> => {
    setError(null);
    setBusyFileId(fileId);
    try {
      const outcome = await createDownloadTicket(code, { fileId });
      if (outcome.kind === 'ok') {
        // Navigating to the presigned URL is the simplest reliable trigger
        // for a download: S3 has signed `Content-Disposition: attachment` so
        // the browser saves rather than navigates-and-renders, and the URL
        // stays inspectable in DevTools.
        window.location.assign(outcome.value.presignedGetUrl);
        return;
      }
      handleRejection(outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start download.');
    } finally {
      setBusyFileId(null);
    }
  };

  const handleRejection = (
    outcome:
      | { kind: 'policy_rejected'; reason: PolicyRejection }
      | { kind: 'not_found' }
      | { kind: 'error'; message: string },
  ): void => {
    if (outcome.kind === 'not_found') {
      setError('This download is no longer available.');
      return;
    }
    if (outcome.kind === 'error') {
      setError(outcome.message);
      return;
    }
    switch (outcome.reason) {
      case 'password_required':
        setError('A password is required to download from this link.');
        break;
      case 'password_wrong':
        setError('Incorrect password. Please try again.');
        break;
      case 'quota_exhausted':
        setError('This link has reached its download limit.');
        break;
      case 'expired':
        setError('This link has expired.');
        break;
      case 'disabled':
        setError('This link is currently disabled.');
        break;
    }
  };

  if (metaError) {
    return (
      <main className="page">
        <h1>File Harbor</h1>
        <p role="alert" className="error">
          This download link is not available. It may be incorrect, disabled, or expired.
        </p>
      </main>
    );
  }

  if (!meta) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>Download</h1>
      <p>
        You&apos;ve been sent: <strong>{meta.label}</strong>
      </p>

      {meta.files.length === 0 ? (
        // The link exists but the admin's upload hasn't finalized yet. Render
        // a soft state rather than a hard error — the recipient can refresh.
        <p className="muted">No files available yet. Try again in a moment.</p>
      ) : (
        <ul className="list-reset stack">
          {meta.files.map((file) => (
            <li key={file.id} className="card row between">
              <div>
                <div>
                  <strong>{file.filename}</strong>
                </div>
                <div className="muted small">
                  {formatBytes(file.size)} · {file.contentType}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onDownload(file.id)}
                disabled={busyFileId !== null}
              >
                {busyFileId === file.id ? 'Preparing…' : 'Download'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
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
