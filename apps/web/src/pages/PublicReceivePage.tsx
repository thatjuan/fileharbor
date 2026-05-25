import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useParams } from 'react-router-dom';

import {
  createUploadTicket,
  finalizeUploadTicket,
  getPublicReceiveLink,
  type PolicyRejection,
  type PublicReceiveLink,
} from '../lib/api.js';
import { uploadFileWithProgress } from '../lib/upload.js';

/**
 * Public upload page (`/r/:code`). Unauthenticated. The whole flow:
 *
 *   1. On mount: fetch `/api/public/receive-links/:code` for the label.
 *      A 404 means "bad code or disabled" — same shape so we can't be probed.
 *   2. If the metadata reports `passwordRequired`, prompt for it BEFORE the
 *      file picker. The password is sent on the ticket-mint call (and again on
 *      finalize) — the server is the only place that decides "correct".
 *   3. User picks a file.
 *   4. Mint a ticket via the public API (with password if set). On
 *      `password_required` / `password_wrong` we surface the inline error and
 *      let the user retype; on `quota_exhausted` / `expired` / `disabled` we
 *      lock the form (no path to recover from the public side).
 *   5. PUT the file directly to S3 with XHR progress tracking.
 *   6. POST to the finalize endpoint with the same password. Server HEADs the
 *      bucket and re-validates the link.
 *   7. Show "complete" or the specific failure reason.
 */
export function PublicReceivePage(): JSX.Element {
  const params = useParams<{ code: string }>();
  const code = params.code ?? '';

  const [meta, setMeta] = useState<PublicReceiveLink | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<
    'idle' | 'minting' | 'uploading' | 'finalizing' | 'completed' | 'failed' | 'locked'
  >('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [completedName, setCompletedName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    getPublicReceiveLink(code)
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

  const onFileChange = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Local copy of the input ref so we can clear it after the upload settles
    // without the closure capturing a stale node.
    const inputEl = fileInputRef.current;

    setError(null);
    setProgress(0);
    setCompletedName(null);

    try {
      // Step 1: mint the ticket.
      setPhase('minting');
      const ticket = await createUploadTicket(code, {
        filename: file.name,
        // Browsers occasionally hand back `''` for `file.type`. The server
        // falls back to `application/octet-stream` in that case; we mirror
        // it client-side so the `Content-Type` header we PUT exactly matches
        // what got signed.
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        password: meta?.passwordRequired ? password : null,
      });

      if (ticket.kind !== 'ok') {
        handleRejection(ticket);
        return;
      }

      // Step 2: PUT to S3 with progress.
      setPhase('uploading');
      const putResult = await uploadFileWithProgress({
        url: ticket.value.presignedPutUrl,
        file,
        contentType: file.type || 'application/octet-stream',
        onProgress: (loaded, total) => {
          if (total > 0) setProgress(Math.round((loaded / total) * 100));
        },
      });
      if (!putResult.ok) {
        throw new Error(
          `Upload to storage failed (status=${putResult.status}). The link may have expired; please retry.`,
        );
      }
      setProgress(100);

      // Step 3: finalize (server HEADs the bucket and re-validates the link).
      setPhase('finalizing');
      const finalizeOutcome = await finalizeUploadTicket(
        ticket.value.ticketId,
        meta?.passwordRequired ? password : null,
      );

      if (finalizeOutcome.kind === 'ok' && finalizeOutcome.value.status === 'completed') {
        setPhase('completed');
        setCompletedName(file.name);
      } else if (finalizeOutcome.kind === 'ok') {
        setPhase('failed');
        setError(
          finalizeOutcome.value.reason === 'object_not_found'
            ? 'The server could not verify your upload. Please try again.'
            : 'Upload failed during finalization.',
        );
      } else {
        handleRejection(finalizeOutcome);
        return;
      }
    } catch (err) {
      setPhase('failed');
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      // Reset the input so the user can pick the same file again after a
      // failure without weirdness.
      if (inputEl) inputEl.value = '';
    }
  };

  /**
   * Render the right inline state for a policy rejection (or generic error).
   * `password_required` / `password_wrong` are recoverable — leave the form
   * usable so the user can retype. The others lock the form.
   */
  const handleRejection = (
    outcome:
      | { kind: 'policy_rejected'; reason: PolicyRejection }
      | { kind: 'not_found' }
      | { kind: 'error'; message: string },
  ): void => {
    if (outcome.kind === 'not_found') {
      setPhase('locked');
      setError('This upload link is not available.');
      return;
    }
    if (outcome.kind === 'error') {
      setPhase('failed');
      setError(outcome.message);
      return;
    }
    switch (outcome.reason) {
      case 'password_required':
        setPhase('idle');
        setError('A password is required to upload to this link.');
        break;
      case 'password_wrong':
        setPhase('idle');
        setError('Incorrect password. Please try again.');
        break;
      case 'quota_exhausted':
        setPhase('locked');
        setError('This link has reached its upload limit and is no longer accepting files.');
        break;
      case 'expired':
        setPhase('locked');
        setError('This link has expired.');
        break;
      case 'disabled':
        setPhase('locked');
        setError('This link is currently disabled.');
        break;
    }
  };

  const onReset = (): void => {
    setPhase('idle');
    setProgress(0);
    setError(null);
    setCompletedName(null);
  };

  if (metaError) {
    return (
      <main className="page">
        <h1>File Harbor</h1>
        <p role="alert" className="error">
          This upload link is not available. It may be incorrect, disabled, or expired.
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

  const busy = phase === 'minting' || phase === 'uploading' || phase === 'finalizing';
  // The file picker requires a password (when set) AND the link must not be
  // in a terminal failure state. Locked = unrecoverable; failed = re-pickable.
  const passwordReady = !meta.passwordRequired || password.length > 0;

  return (
    <main className="page">
      <h1>Upload a file</h1>
      <p>
        You&apos;ve been invited to upload to: <strong>{meta.label}</strong>
      </p>

      {phase === 'completed' && completedName && (
        <div className="stack">
          <p className="success" role="status">
            Upload complete: <strong>{completedName}</strong>
          </p>
          <button type="button" onClick={onReset}>
            Upload another file
          </button>
        </div>
      )}

      {phase === 'locked' && (
        <p role="alert" className="error">
          {error ?? 'This link is no longer accepting uploads.'}
        </p>
      )}

      {phase !== 'completed' && phase !== 'locked' && (
        <div className="stack">
          {meta.passwordRequired && (
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  // Clear a previous password-wrong / password-required error
                  // as soon as the user starts retyping — feels more responsive
                  // than waiting for the next submit.
                  if (error) setError(null);
                }}
                disabled={busy}
                autoComplete="off"
                autoFocus
              />
            </label>
          )}

          <label>
            Pick a file
            <input
              ref={fileInputRef}
              type="file"
              onChange={onFileChange}
              disabled={busy || !passwordReady}
            />
          </label>

          {phase === 'minting' && <p className="muted">Preparing upload…</p>}

          {phase === 'uploading' && (
            <div>
              <progress value={progress} max={100} style={{ width: '100%' }} />
              <div className="muted small">{progress}%</div>
            </div>
          )}

          {phase === 'finalizing' && <p className="muted">Confirming with server…</p>}

          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
