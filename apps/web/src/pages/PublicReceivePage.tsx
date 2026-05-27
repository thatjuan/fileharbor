import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { useParams } from 'react-router-dom';

import { LanguageSwitcher, Trans, mapUploadErrorMessage, useT } from '../i18n/index.js';
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
 *   3. User picks a file (via the drop-card label or by dragging a file onto
 *      the same target).
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
  const t = useT();

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
  const [isDragging, setIsDragging] = useState(false);
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
          setMetaError(err instanceof Error ? err.message : t('receive.notAvailable'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  /**
   * Core upload pipeline. Extracted so both the file-input `onChange` and the
   * drop-target `onDrop` can share the exact same dispatch — including the
   * phase machine, abort wiring, password capture, and error routing.
   */
  const processFile = async (file: File): Promise<void> => {
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
            ? t('errors.uploadObjectNotFound')
            : finalize.reason.length > 0
              ? t('errors.uploadFailedReason', { reason: finalize.reason })
              : t('errors.uploadFailedFinalize'),
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
        setError(t('errors.uploadRejectedReason', { reason: finalize.reason }));
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
      setError(
        err instanceof Error
          ? t(mapUploadErrorMessage(err.message))
          : t('errors.uploadFailedGeneric'),
      );
    } finally {
      // Reset the input so the user can pick the same file again after a
      // failure without weirdness.
      if (inputEl) inputEl.value = '';
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const onFileChange = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFile(file);
  };

  /**
   * User-initiated cancel. The dispatcher tears every in-flight part XHR via
   * the AbortController and fires a best-effort server-side abort with a 5s
   * ceiling. The page state moves to `cancelling` immediately for UI feedback;
   * the `cancelled` terminal is set inside `processFile` once the dispatcher
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
      setError(t('receive.lockedDefault'));
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
        setError(t('errors.passwordRequiredReceive'));
        break;
      case 'password_wrong':
        setPhase('idle');
        setError(t('errors.passwordWrong'));
        break;
      case 'quota_exhausted':
        setPhase('locked');
        setError(t('errors.quotaExhaustedReceive'));
        break;
      case 'expired':
        setPhase('locked');
        setError(t('errors.expired'));
        break;
      case 'disabled':
        setPhase('locked');
        setError(t('errors.disabled'));
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
      <main className="public-main tile tile-parchment">
        <LanguageSwitcher />
        <div className="container-narrow public-hero">
          <h1>File Harbor</h1>
          <p role="alert" className="error">
            {t('receive.notAvailable')}
          </p>
        </div>
        <PublicFooter />
      </main>
    );
  }

  if (!meta || !uploadConfig) {
    return (
      <main className="public-main tile tile-parchment">
        <LanguageSwitcher />
        <div className="container-narrow public-hero">
          <p className="muted">{t('common.loading')}</p>
        </div>
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
  const pickerDisabled = busy || !passwordReady;

  /**
   * Drag-and-drop wiring. `onDragOver` MUST call `preventDefault()` or the
   * browser refuses `onDrop`. While `pickerDisabled` is true (busy or
   * password-not-typed) we short-circuit so dropping cannot bypass the gate.
   */
  const onDragOver = (event: DragEvent<HTMLLabelElement>): void => {
    if (pickerDisabled) return;
    event.preventDefault();
    if (!isDragging) setIsDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLLabelElement>): void => {
    // Only treat as "leave" when leaving the card itself, not a child element.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    setIsDragging(false);
    if (pickerDisabled) return;
    const file = event.dataTransfer.files?.[0];
    if (file) void processFile(file);
  };

  return (
    <main className="public-main tile tile-parchment">
      <LanguageSwitcher />
      <div className="container-narrow public-hero">
        <h1>{t('receive.title')}</h1>
        <p className="lead">
          <Trans k="receive.invitedTo" components={{ label: <strong>{meta.label}</strong> }} />
        </p>

        {phase === 'completed' && completedName && (
          <div className="public-action success-block">
            <SuccessCheck />
            <p className="success" role="status">
              <Trans
                k="receive.uploadComplete"
                components={{ name: <strong>{completedName}</strong> }}
              />
            </p>
            <div>
              <button type="button" className="btn-primary" onClick={onReset}>
                {t('receive.uploadAnother')}
              </button>
            </div>
          </div>
        )}

        {phase === 'locked' && (
          <div className="public-action">
            <p role="alert" className="error">
              {error ?? t('receive.lockedDefault')}
            </p>
          </div>
        )}

        {phase !== 'completed' && phase !== 'locked' && (
          <div className="public-action">
            {meta.passwordRequired && (
              <label className="input-label">
                {t('receive.password')}
                <input
                  type="password"
                  className="input-pill"
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

            {phase !== 'uploading' && phase !== 'minting' && phase !== 'finalizing' && (
              <label
                className={`drop-card${isDragging ? ' is-dragging' : ''}`}
                aria-disabled={pickerDisabled}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
              >
                <span className="drop-card-title">{t('receive.pickFile')}</span>
                <span className="drop-card-hint">{t('receive.dropHint')}</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="sr-only"
                  onChange={onFileChange}
                  disabled={pickerDisabled}
                />
              </label>
            )}

            {phase === 'minting' && <p className="muted">{t('receive.preparing')}</p>}

            {phase === 'uploading' && (
              <div className="progress-block">
                <div className="progress-percent">{progress}%</div>
                <div className="progress-caption">{t('receive.uploadingPhase')}</div>
                <progress value={progress} max={100} />
              </div>
            )}

            {phase === 'finalizing' && <p className="muted">{t('receive.confirming')}</p>}

            {phase === 'cancelling' && <p className="muted">{t('receive.cancelling')}</p>}

            {phase === 'cancelled' && (
              <div className="stack">
                <p className="muted">{t('receive.cancelled')}</p>
                <div className="row" style={{ justifyContent: 'center' }}>
                  <button type="button" className="btn-primary" onClick={onRetryAfterCancel}>
                    {t('common.tryAgain')}
                  </button>
                </div>
              </div>
            )}

            {cancellable && (
              <div className="row" style={{ justifyContent: 'center' }}>
                <button type="button" className="btn-secondary-pill" onClick={onCancel}>
                  {t('receive.cancelUpload')}
                </button>
              </div>
            )}

            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
      <PublicFooter />
    </main>
  );
}

/** Tiny quiet brand line so the page doesn't end on the action. */
function PublicFooter(): JSX.Element {
  const t = useT();
  return <div className="public-footer">{t('footer.poweredBy')}</div>;
}

/**
 * Large Action-Blue checkmark for the success state. Inline SVG to avoid
 * any asset dependency and to pick up `currentColor` from the parent class.
 */
function SuccessCheck(): JSX.Element {
  return (
    <svg
      className="success-check"
      viewBox="0 0 56 56"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="28" cy="28" r="24" />
      <path d="M18 29l7 7 14-17" />
    </svg>
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
