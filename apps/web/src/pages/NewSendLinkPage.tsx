import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { SubNav } from '../components/SubNav.js';
import {
  abortSendMultipartUploadTicket,
  addFileToSendLink,
  completeSendMultipartUploadTicket,
  createSendLink,
  createSendMultipartUploadTicket,
  fetchSendMultipartPartUrls,
  finalizeUploadTicket,
  type FinalizeOutcome,
} from '../lib/api.js';
import { uploadFile, type UploadFinalizeOutcome } from '../lib/upload.js';
import { DEFAULT_UPLOAD_CONFIG, getUploadConfig, type UploadConfig } from '../lib/upload-config.js';

/**
 * Form to create a new send link. The #11 flow is:
 *
 *   1. Admin enters a label, optional policy fields (password / maxDownloads /
 *      expiresAt), and picks one or more files.
 *   2. On submit, `POST /api/send-links` with just `{ label, password?,
 *      maxDownloads?, expiresAt? }` — no file yet. The link is now empty.
 *   3. For each picked file: `POST /api/send-links/:id/files` to mint a
 *      ticket, PUT the file to S3, finalize. Done serially so the progress
 *      bar tracks one file at a time and a mid-bundle failure is recoverable.
 *   4. Redirect to `/links/send/:id`. If only some files finalised, the
 *      admin lands on a partially-populated detail page and can retry from
 *      there (the detail-page "add file" path is wired but not surfaced as
 *      a button yet — that's a #12 follow-up).
 *
 * The "create link" call is what registers the policy; even if all the
 * subsequent file uploads fail, the link still exists with the right
 * password/expiry/quota configured. The PRD and #11 explicitly accept an
 * empty link as a legitimate intermediate state.
 */
export function NewSendLinkPage(): JSX.Element {
  const navigate = useNavigate();
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [maxDownloads, setMaxDownloads] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [filesPicked, setFilesPicked] = useState<File[]>([]);
  const [phase, setPhase] = useState<'idle' | 'creating' | 'uploading' | 'finalizing' | 'done'>(
    'idle',
  );
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Server-issued multipart threshold + part size. `null` while the
  // `/api/config/upload` fetch is in flight; the submit button is gated on
  // its presence. `getUploadConfig()` never rejects (singleton handles its
  // own fallback) so we don't need a separate error state.
  const [uploadConfig, setUploadConfig] = useState<UploadConfig | null>(null);
  /**
   * Single controller per submission, recreated on each Create-link click.
   * The Cancel button calls `.abort()`, which tears the in-flight file's
   * part XHRs and propagates out of the dispatcher; the per-file loop
   * checks `signal.aborted` and stops, leaving any already-finalized files
   * intact on the partially-populated link.
   */
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    getUploadConfig()
      .then((c) => {
        if (!cancelled) setUploadConfig(c);
      })
      .catch(() => {
        // `getUploadConfig` already swallows errors and returns defaults;
        // the catch is here only as a structural safety net.
        if (!cancelled) setUploadConfig(DEFAULT_UPLOAD_CONFIG);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onFilesChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setFilesPicked(Array.from(e.target.files ?? []));
  };

  const onRemoveFile = (indexToRemove: number): void => {
    setFilesPicked((prev) => prev.filter((_, i) => i !== indexToRemove));
  };

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (filesPicked.length === 0) {
      setError('Pick at least one file to share.');
      return;
    }

    setError(null);
    setProgress(0);
    setCurrentFileIndex(0);

    // Fresh controller per submission. The Cancel button calls `.abort()`,
    // which the dispatcher honours per-file and propagates as a throw out
    // of the loop body.
    const controller = new AbortController();
    abortRef.current = controller;
    const cfg = uploadConfig ?? DEFAULT_UPLOAD_CONFIG;

    try {
      // Parse the optional policy fields. Mirror `NewReceiveLinkPage`'s shape
      // so the two forms behave the same way.
      let parsedMaxDownloads: number | null = null;
      if (maxDownloads.trim().length > 0) {
        const n = Number(maxDownloads);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error('Max downloads must be a positive whole number.');
        }
        parsedMaxDownloads = n;
      }

      let parsedExpiresAt: number | null = null;
      if (expiresAt.length > 0) {
        const d = new Date(expiresAt);
        if (Number.isNaN(d.getTime())) {
          throw new Error('Expiry date is not a valid date/time.');
        }
        if (d.getTime() <= Date.now()) {
          throw new Error('Expiry date must be in the future.');
        }
        parsedExpiresAt = Math.floor(d.getTime() / 1000);
      }

      setPhase('creating');
      const link = await createSendLink({
        label: label.trim(),
        password: password.length > 0 ? password : null,
        maxDownloads: parsedMaxDownloads,
        expiresAt: parsedExpiresAt,
      });

      // Upload each file in sequence via the dispatcher. Parallel would be
      // faster but a single progress bar is the v1 UX, and serial means a
      // failure on file N leaves files 1..N-1 already finalized — clean
      // state for retry. The dispatcher handles single-PUT vs multipart per
      // file based on `file.size` vs `cfg.multipartThresholdBytes`.
      for (let i = 0; i < filesPicked.length; i++) {
        // Honour an in-flight Cancel before starting the next file.
        if (controller.signal.aborted) {
          throw new DOMException('Upload cancelled', 'AbortError');
        }
        setCurrentFileIndex(i);
        const file = filesPicked[i];
        if (!file) continue; // unreachable given the loop bound; satisfies TS noUncheckedIndexedAccess
        const contentType = file.type || 'application/octet-stream';

        setPhase('uploading');
        setProgress(0);

        const result = await uploadFile({
          file,
          contentType,
          threshold: cfg.multipartThresholdBytes,
          partSizeBytes: cfg.multipartPartSizeBytes,
          single: {
            presign: async () => {
              const ticket = await addFileToSendLink(link.id, {
                filename: file.name,
                contentType,
                size: file.size,
              });
              return {
                presignedPutUrl: ticket.presignedPutUrl,
                ticketId: ticket.ticketId,
              };
            },
            finalize: async (ticketId) => {
              setPhase('finalizing');
              const outcome = await finalizeUploadTicket(ticketId, null);
              return adaptFinalizeOutcome(outcome);
            },
          },
          multipart: {
            init: async () => {
              const out = await createSendMultipartUploadTicket(link.id, {
                filename: file.name,
                contentType,
                size: file.size,
              });
              if (out.kind !== 'ok') {
                throw new Error(
                  out.kind === 'policy_rejected'
                    ? `Link policy rejected: ${out.reason}.`
                    : out.kind === 'not_found'
                      ? 'Send link not found.'
                      : out.message,
                );
              }
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
              const out = await fetchSendMultipartPartUrls(link.id, ticketId, from, to);
              if (out.kind !== 'ok') {
                // Throwing aborts the dispatcher's worker loop; it then
                // calls `multipart.abort()` to tear the server session.
                throw new Error(`Failed to fetch part URLs (${out.kind}).`);
              }
              return out.value.urls;
            },
            complete: async (ticketId, parts) => {
              setPhase('finalizing');
              const outcome = await completeSendMultipartUploadTicket(link.id, ticketId, {
                parts,
              });
              return adaptFinalizeOutcome(outcome);
            },
            abort: (ticketId) => abortSendMultipartUploadTicket(link.id, ticketId),
          },
          onProgress: ({ loaded, total }) => {
            if (total > 0) setProgress(Math.round((loaded / total) * 100));
          },
          signal: controller.signal,
        });

        // Cancel: the dispatcher returns a failed/error outcome with the
        // signal aborted. Re-throw as AbortError so the catch below treats
        // it as cancellation rather than a real failure.
        if (controller.signal.aborted) {
          throw new DOMException('Upload cancelled', 'AbortError');
        }

        const finalize = result.outcome;
        if (finalize.kind === 'ok') {
          setProgress(100);
          continue;
        }
        throw new Error(describeUploadFinalizeFailure(file.name, finalize));
      }

      setPhase('done');
      navigate(`/links/send/${link.id}`, { replace: true });
    } catch (err) {
      setPhase('idle');
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Upload cancelled. The send link was created; files uploaded so far are intact.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create send link.');
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const onCancel = (): void => {
    if (!abortRef.current) return;
    abortRef.current.abort();
  };

  const busy = phase !== 'idle' && phase !== 'done';

  return (
    <>
      <SubNav
        title="New send link"
        actions={
          <Link to="/" className="text-link">
            Back to dashboard
          </Link>
        }
      />
      <section className="container-form">
        <header className="stack-tight">
          <h1>New send link</h1>
          <p className="lead">
            A send link lets others download files you upload. Share the URL (and password, if you
            set one) out-of-band.
          </p>
        </header>
        <form onSubmit={onSubmit} className="stack-airy">
          <label className="input-label">
            Label
            <input
              type="text"
              className="input-pill"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Q3 audit pack"
              required
              maxLength={256}
              autoFocus
              disabled={busy}
            />
          </label>

          <label className="input-label">
            Password <span className="muted small">(optional)</span>
            {/*
              Plain `text` (not `password`) for the same reason as the receive
              form: the admin shares this out-of-band and wants to see it.
            */}
            <input
              type="text"
              className="input-pill"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank for no password"
              autoComplete="off"
              disabled={busy}
            />
          </label>

          <label className="input-label">
            Max downloads <span className="muted small">(optional)</span>
            <input
              type="number"
              className="input-pill"
              value={maxDownloads}
              onChange={(e) => setMaxDownloads(e.target.value)}
              placeholder="Leave blank for unlimited"
              min={1}
              step={1}
              disabled={busy}
            />
          </label>

          <label className="input-label">
            Expires at <span className="muted small">(optional, local time)</span>
            <input
              type="datetime-local"
              className="input-pill"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              disabled={busy}
            />
          </label>

          <div className="stack-tight">
            <span className="input-label">Files</span>
            {/*
              Visually a `.btn-secondary-pill` label; the native `<input
              type="file">` lives inside it, kept in the DOM (focusable for
              keyboard users) but visually hidden with the inline style below.
              `aria-label` makes the file picker self-describing for assistive
              tech since the label text is decorative.
            */}
            <label
              className="btn-secondary-pill"
              style={{ alignSelf: 'flex-start', cursor: busy ? 'not-allowed' : 'pointer' }}
            >
              {filesPicked.length === 0 ? 'Choose files…' : 'Choose different files…'}
              <input
                type="file"
                multiple
                onChange={onFilesChange}
                disabled={busy}
                aria-label="Choose files to upload"
                style={{
                  position: 'absolute',
                  width: 1,
                  height: 1,
                  padding: 0,
                  margin: -1,
                  overflow: 'hidden',
                  clip: 'rect(0, 0, 0, 0)',
                  whiteSpace: 'nowrap',
                  border: 0,
                }}
              />
            </label>
            {filesPicked.length > 0 && (
              <div className="stack" style={{ marginBlockStart: 'var(--space-sm)' }}>
                {filesPicked.map((file, i) => (
                  <div className="store-card-row" key={`${file.name}-${i}`}>
                    <div className="stack-tight">
                      <span className="body-strong">{file.name}</span>
                      <span className="muted small">
                        {formatBytes(file.size)}
                        {file.type ? ` · ${file.type}` : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn-icon-circular"
                      onClick={() => onRemoveFile(i)}
                      disabled={busy}
                      aria-label={`Remove ${file.name}`}
                      title={`Remove ${file.name}`}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M3 3 L13 13 M13 3 L3 13"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  </div>
                ))}
                {filesPicked.length > 1 && (
                  <span className="muted small">
                    {filesPicked.length} files selected. They will upload one at a time.
                  </span>
                )}
              </div>
            )}
          </div>

          {phase === 'creating' && <p className="muted">Preparing link…</p>}
          {(phase === 'uploading' || phase === 'finalizing') && filesPicked.length > 0 && (
            <div className="stack-tight">
              <div className="muted small">
                {phase === 'uploading' ? 'Uploading' : 'Confirming'} file {currentFileIndex + 1} of{' '}
                {filesPicked.length}: <strong>{filesPicked[currentFileIndex]?.name}</strong>
              </div>
              <progress value={progress} max={100} />
              <div className="muted small">{progress}%</div>
            </div>
          )}

          {error && (
            <p role="alert" className="muted">
              {error}
            </p>
          )}
          <div className="row end">
            {busy ? (
              // Cancel applies to the current submission: tears the in-flight
              // file's part XHRs, calls the server-side abort, and bails the
              // loop. Files already finalized stay attached to the new link.
              <button type="button" className="btn-secondary-pill" onClick={onCancel}>
                Cancel
              </button>
            ) : (
              <Link to="/" className="btn-secondary-pill">
                Cancel
              </Link>
            )}
            <button
              type="submit"
              className="btn-primary"
              disabled={
                busy ||
                label.trim().length === 0 ||
                filesPicked.length === 0 ||
                uploadConfig === null
              }
            >
              {busy ? 'Creating…' : 'Create send link'}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}

/**
 * Bridge from `api.ts` `FinalizeOutcome` (nested `{ kind:'ok', value:{ status,
 * reason? } }`) to `upload.ts` `UploadFinalizeOutcome` (flat
 * `{ kind:'ok' } | { kind:'failed', reason } | ...`). Required because the
 * dispatcher's `SinglePutDeps.finalize` / `MultipartDeps.complete` are typed
 * against the flat union.
 */
function adaptFinalizeOutcome(outcome: FinalizeOutcome): UploadFinalizeOutcome {
  if (outcome.kind === 'ok') {
    if (outcome.value.status === 'completed') return { kind: 'ok' };
    return { kind: 'failed', reason: outcome.value.reason ?? 'unknown' };
  }
  return outcome;
}

/**
 * Map an `UploadFinalizeOutcome` failure branch into a user-facing message
 * including the file name. Mirrors the structure of the old `describeFailure`
 * helper but takes the flat `upload.ts` shape rather than the `api.ts` nested
 * outcome.
 */
function describeUploadFinalizeFailure(
  filename: string,
  outcome: Exclude<UploadFinalizeOutcome, { kind: 'ok' }>,
): string {
  if (outcome.kind === 'failed') {
    if (outcome.reason === 'object_not_found') {
      return `The server could not verify "${filename}". Please try again.`;
    }
    return `Upload failed for "${filename}": ${outcome.reason}.`;
  }
  if (outcome.kind === 'not_found') {
    return `Upload ticket for "${filename}" was not found.`;
  }
  if (outcome.kind === 'policy_rejected') {
    return `Link policy rejected "${filename}": ${outcome.reason}.`;
  }
  return `Upload failed for "${filename}": ${outcome.message}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
