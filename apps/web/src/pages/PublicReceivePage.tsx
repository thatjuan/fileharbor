import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useParams } from 'react-router-dom';

import {
  abortMultipartUploadTicket,
  completeMultipartUploadTicket,
  createMultipartUploadTicket,
  createUploadTicket,
  fetchMultipartPartUrls,
  finalizeUploadTicket,
  getPublicReceiveLink,
  type FinalizeOutcome,
  type PolicyRejection,
  type PublicReceiveLink,
} from '../lib/api.js';
import { uploadFile, type UploadFinalizeOutcome } from '../lib/upload.js';
import { DEFAULT_UPLOAD_CONFIG, getUploadConfig, type UploadConfig } from '../lib/upload-config.js';

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
  // `null` until the first `/api/config/upload` fetch settles. The picker is
  // gated on this so a zero-size threshold can never dispatch incorrectly.
  // `getUploadConfig()` itself never rejects (falls back to defaults internally),
  // but we still guard with `?? DEFAULT_UPLOAD_CONFIG` as a structural safety net.
  const [uploadConfig, setUploadConfig] = useState<UploadConfig | null>(null);

  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<
    | 'idle'
    | 'minting'
    | 'uploading'
    | 'finalizing'
    | 'completed'
    | 'failed'
    | 'locked'
    | 'cancelling'
    | 'cancelled'
  >('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [completedName, setCompletedName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * Controller for the in-flight upload. Recreated per upload attempt; the
   * Cancel button fires `.abort()`, which the dispatcher in `lib/upload.ts`
   * threads down to every part XHR and the best-effort server abort.
   */
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Fetch link metadata and upload config in parallel — both are page
    // pre-requisites and there's no order dependency. The config promise
    // never rejects (singleton handles its own errors with a fallback) so
    // the link metadata is the only failure source here.
    Promise.all([getPublicReceiveLink(code), getUploadConfig()])
      .then(([m, c]) => {
        if (!cancelled) {
          setMeta(m);
          setUploadConfig(c);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          // Belt-and-braces: if `getUploadConfig` ever changes to reject,
          // still set a usable config so the picker can mount.
          setUploadConfig((prev) => prev ?? DEFAULT_UPLOAD_CONFIG);
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
    // The picker is `disabled` until `uploadConfig` resolves; the guard here
    // is belt-and-braces against a synthetic event firing pre-resolve.
    const cfg = uploadConfig ?? DEFAULT_UPLOAD_CONFIG;

    // Local copy of the input ref so we can clear it after the upload settles
    // without the closure capturing a stale node.
    const inputEl = fileInputRef.current;

    setError(null);
    setProgress(0);
    setCompletedName(null);

    // Fresh controller per attempt — abort() on the previous one would not
    // affect a new XHR. Wired into `uploadFile(..., signal)` below.
    const controller = new AbortController();
    abortRef.current = controller;

    // Cache the password value used for THIS upload. If the user retypes
    // the password mid-upload, the in-flight calls must still see the value
    // that policy was checked against at mint time.
    const pwForThisUpload = meta?.passwordRequired ? password : null;
    const contentType = file.type || 'application/octet-stream';

    try {
      // The dispatcher transitions through minting → uploading → finalizing
      // internally; we mark `uploading` up front because the picker is now
      // disabled and `minting` is brief. For very large files the multipart
      // path spends nearly all of its time in the worker loop, so a
      // `uploading` phase from the start gives the best UI continuity.
      setPhase('uploading');

      const result = await uploadFile({
        file,
        contentType,
        threshold: cfg.multipartThresholdBytes,
        partSizeBytes: cfg.multipartPartSizeBytes,
        single: {
          presign: async () => {
            // Surface single-PUT mint phase distinctly — only single-PUT
            // path runs this branch; multipart calls `multipart.init()`.
            setPhase('minting');
            const ticket = await createUploadTicket(code, {
              filename: file.name,
              contentType,
              size: file.size,
              password: pwForThisUpload,
            });
            if (ticket.kind !== 'ok') {
              // Surface the policy/error to the page and throw to bail the
              // dispatcher. The catch block at the end will see this throw
              // and intentionally NOT overwrite the page state set by
              // handleRejection.
              handleRejection(ticket);
              throw new SuppressUiError('rejected at mint');
            }
            setPhase('uploading');
            return {
              presignedPutUrl: ticket.value.presignedPutUrl,
              ticketId: ticket.value.ticketId,
            };
          },
          finalize: async (ticketId) => {
            setPhase('finalizing');
            const outcome = await finalizeUploadTicket(ticketId, pwForThisUpload);
            return adaptFinalizeOutcome(outcome);
          },
        },
        multipart: {
          init: async () => {
            setPhase('minting');
            const out = await createMultipartUploadTicket(code, {
              filename: file.name,
              contentType,
              size: file.size,
              password: pwForThisUpload,
            });
            if (out.kind !== 'ok') {
              handleRejection(out);
              throw new SuppressUiError('rejected at multipart init');
            }
            setPhase('uploading');
            return {
              ticketId: out.value.ticketId,
              uploadId: out.value.uploadId,
              partSize: out.value.partSize,
              expectedParts: out.value.expectedParts,
              initialUrls: out.value.initialUrls,
              paginated: out.value.paginated,
            };
          },
          fetchPartUrls: async (ticketId, from, to) => {
            const out = await fetchMultipartPartUrls(ticketId, from, to, pwForThisUpload);
            if (out.kind !== 'ok') {
              // Throwing here aborts the dispatcher's worker loop and routes
              // through its abort path — the multipart session is torn down
              // server-side via `multipart.abort()`.
              throw new Error(`Failed to fetch part URLs (${out.kind}).`);
            }
            return out.value.urls;
          },
          complete: async (ticketId, parts) => {
            setPhase('finalizing');
            const outcome = await completeMultipartUploadTicket(ticketId, {
              parts,
              password: pwForThisUpload,
            });
            return adaptFinalizeOutcome(outcome);
          },
          abort: (ticketId) => abortMultipartUploadTicket(ticketId, pwForThisUpload),
        },
        onProgress: ({ loaded, total }) => {
          if (total > 0) setProgress(Math.round((loaded / total) * 100));
        },
        signal: controller.signal,
      });

      // If the user clicked Cancel, the dispatcher returns an `error` /
      // `failed` outcome with `controller.signal.aborted === true`. Treat
      // that as a soft cancel, not an error to display.
      if (controller.signal.aborted) {
        setPhase('cancelled');
        setProgress(0);
        return;
      }

      const finalize = result.outcome;
      if (finalize.kind === 'ok') {
        setPhase('completed');
        setProgress(100);
        setCompletedName(file.name);
        return;
      }
      if (finalize.kind === 'failed') {
        setPhase('failed');
        setError(
          finalize.reason === 'object_not_found'
            ? 'The server could not verify your upload. Please try again.'
            : finalize.reason.length > 0
              ? `Upload failed: ${finalize.reason}`
              : 'Upload failed during finalization.',
        );
        return;
      }
      // `policy_rejected` / `not_found` / `error` — same handler the
      // single-PUT path already used for the same kinds. The dispatcher's
      // outcome union types `policy_rejected.reason` as `string` (because
      // `upload.ts` has no dependency on `api.ts`); narrow back to the
      // known set before delegating, falling through to a generic error
      // for anything unrecognised (server contract drift).
      if (finalize.kind === 'policy_rejected') {
        const rejection = asKnownPolicyRejection(finalize.reason);
        if (rejection !== null) {
          handleRejection({ kind: 'policy_rejected', reason: rejection });
          return;
        }
        setPhase('failed');
        setError(`Upload rejected: ${finalize.reason}`);
        return;
      }
      handleRejection(finalize);
    } catch (err) {
      // SuppressUiError means handleRejection has already set the page
      // state; the dispatcher's downstream abort fired with controller.abort()
      // (it didn't in this case, but the throw propagates here regardless).
      if (err instanceof SuppressUiError) return;
      // Honour an in-flight cancel even on unexpected throws.
      if (controller.signal.aborted) {
        setPhase('cancelled');
        setProgress(0);
        return;
      }
      setPhase('failed');
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      // Reset the input so the user can pick the same file again after a
      // failure without weirdness.
      if (inputEl) inputEl.value = '';
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  /**
   * User-initiated cancel. The dispatcher tears every in-flight part XHR via
   * the AbortController and fires a best-effort server-side abort with a 5s
   * ceiling. The page state moves to `cancelling` immediately for UI feedback;
   * the `cancelled` terminal is set inside `onFileChange` once the dispatcher
   * settles.
   */
  const onCancel = (): void => {
    if (!abortRef.current) return;
    setPhase('cancelling');
    abortRef.current.abort();
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

  const onRetryAfterCancel = (): void => {
    setPhase('idle');
    setProgress(0);
    setError(null);
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

  if (!meta || !uploadConfig) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const busy =
    phase === 'minting' ||
    phase === 'uploading' ||
    phase === 'finalizing' ||
    phase === 'cancelling';
  const cancellable = phase === 'minting' || phase === 'uploading' || phase === 'finalizing';
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

          {phase === 'cancelling' && <p className="muted">Cancelling…</p>}

          {phase === 'cancelled' && (
            <div className="stack">
              <p className="muted">Upload cancelled.</p>
              <button type="button" onClick={onRetryAfterCancel}>
                Try again
              </button>
            </div>
          )}

          {cancellable && (
            <button type="button" onClick={onCancel}>
              Cancel upload
            </button>
          )}

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

/**
 * Sentinel error thrown out of a `SinglePutDeps.presign` / `MultipartDeps.init`
 * hook when the server returned a policy/error outcome that has already been
 * surfaced to the UI via `handleRejection`. The outer `catch` swallows it so
 * the page state set by `handleRejection` survives.
 */
class SuppressUiError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SuppressUiError';
  }
}

/**
 * Bridge from `api.ts` `FinalizeOutcome` (nested `{ kind:'ok', value:{ status,
 * reason? } }`) to `upload.ts` `UploadFinalizeOutcome` (flat
 * `{ kind:'ok' } | { kind:'failed', reason } | ...`). Required because the
 * dispatcher's `SinglePutDeps.finalize` / `MultipartDeps.complete` are typed
 * against the flat union — that's where the shared logic for both protocols
 * lives.
 */
/**
 * Narrow a `string` (from `upload.ts` `UploadFinalizeOutcome.policy_rejected.reason`,
 * which is typed as `string` to keep `upload.ts` free of `api.ts` dependencies)
 * back to the known `PolicyRejection` union. Returns `null` for any unknown
 * code (server contract drift); callers fall through to a generic error.
 */
const KNOWN_POLICY_REJECTIONS: readonly PolicyRejection[] = [
  'disabled',
  'expired',
  'quota_exhausted',
  'password_required',
  'password_wrong',
];

function asKnownPolicyRejection(value: string): PolicyRejection | null {
  return (KNOWN_POLICY_REJECTIONS as readonly string[]).includes(value)
    ? (value as PolicyRejection)
    : null;
}

function adaptFinalizeOutcome(outcome: FinalizeOutcome): UploadFinalizeOutcome {
  if (outcome.kind === 'ok') {
    if (outcome.value.status === 'completed') return { kind: 'ok' };
    return { kind: 'failed', reason: outcome.value.reason ?? 'unknown' };
  }
  return outcome;
}
