import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import {
  confirmDownloadTicket,
  createDownloadTicket,
  getPublicSendLink,
  type PolicyRejection,
  type PublicSendLink,
} from '../lib/api.js';

/**
 * Public download page (`/s/:code`). Unauthenticated. Lists the files in the
 * send link and, on Download, mints a presigned GET server-side and triggers
 * the browser to navigate to it. The file lands directly from S3 (with
 * Content-Disposition: attachment) — File Harbor never touches the bytes.
 *
 * #11 widens the surface:
 *
 *   - If `passwordRequired` is true, the recipient must type the password
 *     before any download mint is attempted. The password is sent with each
 *     mint request (the server re-validates on every call — we never trust
 *     the client's "I'm authed" state).
 *   - Each file in the bundle gets its own Download button. Clicking mints
 *     a fresh download ticket and triggers a navigation to the presigned URL.
 *   - After kicking off the navigation, we fire-and-forget a `confirm` call
 *     so the server can burn one quota slot. If the user navigates away
 *     before this completes, `fetch(..., { keepalive: true })` still gets the
 *     request out, and the eventual-expiry sweep (#10) is the safety net.
 *   - Quota / expiry / password verdicts are all surfaced with distinct
 *     copy. `quota_exhausted` returns a 403 with `error: 'quota_exhausted'`;
 *     the public listing GET keeps showing the link as "ok" until the cap
 *     is reached on a per-mint basis.
 */
export function PublicSendPage(): JSX.Element {
  const params = useParams<{ code: string }>();
  const code = params.code ?? '';

  const [meta, setMeta] = useState<PublicSendLink | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  // Once the recipient successfully mints a ticket with the password, we
  // remember it locally for subsequent file downloads in the same session.
  // Cleared on a `password_wrong` so the input goes back to empty.
  const [unlockedPassword, setUnlockedPassword] = useState<string | null>(null);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPublicSendLink(code)
      .then((m) => {
        if (!cancelled) {
          setMeta(m);
          // If the link has no password, treat the recipient as already
          // unlocked — keeps the download flow a single click.
          if (!m.passwordRequired) setUnlockedPassword('');
        }
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
      const outcome = await createDownloadTicket(code, {
        fileId,
        password: unlockedPassword,
      });
      if (outcome.kind === 'ok') {
        // Best-effort confirm. Fired BEFORE the navigation so `keepalive`
        // has the freshest chance to land — but the navigation must
        // actually start, hence the synchronous `window.location.assign`
        // immediately after.
        void confirmDownloadTicket(outcome.value.ticketId, 'completed');
        // Navigating to the presigned URL is the simplest reliable trigger
        // for a download: S3 has signed `Content-Disposition: attachment` so
        // the browser saves rather than navigates-and-renders.
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
        // Server says we need a password but the input was empty. Don't blow
        // away `unlockedPassword` here — the user may just have skipped
        // typing it.
        setError('A password is required to download from this link.');
        setUnlockedPassword(null);
        break;
      case 'password_wrong':
        setError('Incorrect password. Please try again.');
        setUnlockedPassword(null);
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

  const passwordGate = meta.passwordRequired && unlockedPassword === null;

  return (
    <main className="page">
      <h1>Download</h1>
      <p>
        You&apos;ve been sent: <strong>{meta.label}</strong>
      </p>

      {meta.remainingDownloads !== null && (
        <p className="muted small">
          {meta.remainingDownloads} download{meta.remainingDownloads === 1 ? '' : 's'} remaining
          {meta.maxDownloads !== null ? ` (of ${meta.maxDownloads})` : ''}.
        </p>
      )}

      {passwordGate ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            // Soft-unlock: hand the typed password to subsequent download
            // mints. The real validation happens server-side on each call.
            if (password.length > 0) setUnlockedPassword(password);
          }}
        >
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button type="submit" disabled={password.length === 0}>
            Unlock
          </button>
        </form>
      ) : meta.files.length === 0 ? (
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

      {!passwordGate && error && (
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
