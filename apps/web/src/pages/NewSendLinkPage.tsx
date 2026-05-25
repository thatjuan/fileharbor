import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import {
  addFileToSendLink,
  createSendLink,
  finalizeUploadTicket,
  type PolicyRejection,
} from '../lib/api.js';
import { uploadFileWithProgress } from '../lib/upload.js';

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
  const [phase, setPhase] = useState<
    'idle' | 'creating' | 'uploading' | 'finalizing' | 'done'
  >('idle');
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const onFilesChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setFilesPicked(Array.from(e.target.files ?? []));
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

      // Upload each file in sequence. Parallel would be faster but a single
      // progress bar is the v1 UX and serial means a failure on file N
      // leaves files 1..N-1 already finalized — clean state for retry.
      for (let i = 0; i < filesPicked.length; i++) {
        setCurrentFileIndex(i);
        const file = filesPicked[i];
        if (!file) continue; // unreachable given the loop bound; satisfies TS noUncheckedIndexedAccess
        const contentType = file.type || 'application/octet-stream';

        setPhase('uploading');
        setProgress(0);

        const ticket = await addFileToSendLink(link.id, {
          filename: file.name,
          contentType,
          size: file.size,
        });

        const putResult = await uploadFileWithProgress({
          url: ticket.presignedPutUrl,
          file,
          contentType,
          onProgress: (loaded, total) => {
            if (total > 0) setProgress(Math.round((loaded / total) * 100));
          },
        });
        if (!putResult.ok) {
          throw new Error(
            `Upload to storage failed for "${file.name}" (status=${putResult.status}).`,
          );
        }
        setProgress(100);

        setPhase('finalizing');
        const outcome = await finalizeUploadTicket(ticket.ticketId, null);
        if (outcome.kind !== 'ok' || outcome.value.status !== 'completed') {
          throw new Error(describeFailure(outcome));
        }
      }

      setPhase('done');
      navigate(`/links/send/${link.id}`, { replace: true });
    } catch (err) {
      setPhase('idle');
      setError(err instanceof Error ? err.message : 'Failed to create send link.');
    }
  };

  const busy = phase !== 'idle' && phase !== 'done';

  return (
    <main className="page">
      <header className="row between">
        <h1>New send link</h1>
        <Link to="/">Back</Link>
      </header>
      <form onSubmit={onSubmit} className="stack">
        <label>
          Label
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Q3 audit pack"
            required
            maxLength={256}
            autoFocus
            disabled={busy}
          />
        </label>

        <label>
          Password <span className="muted small">(optional)</span>
          {/*
            Plain `text` (not `password`) for the same reason as the receive
            form: the admin shares this out-of-band and wants to see it.
          */}
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave blank for no password"
            autoComplete="off"
            disabled={busy}
          />
        </label>

        <label>
          Max downloads <span className="muted small">(optional)</span>
          <input
            type="number"
            value={maxDownloads}
            onChange={(e) => setMaxDownloads(e.target.value)}
            placeholder="Leave blank for unlimited"
            min={1}
            step={1}
            disabled={busy}
          />
        </label>

        <label>
          Expires at <span className="muted small">(optional, local time)</span>
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            disabled={busy}
          />
        </label>

        <label>
          Files
          <input type="file" multiple onChange={onFilesChange} disabled={busy} required />
          {filesPicked.length > 1 && (
            <span className="muted small">
              {filesPicked.length} files selected. They will upload one at a time.
            </span>
          )}
        </label>

        {phase === 'creating' && <p className="muted">Preparing link…</p>}
        {(phase === 'uploading' || phase === 'finalizing') && filesPicked.length > 0 && (
          <div>
            <div className="muted small">
              {phase === 'uploading' ? 'Uploading' : 'Confirming'} file{' '}
              {currentFileIndex + 1} of {filesPicked.length}:{' '}
              <strong>{filesPicked[currentFileIndex]?.name}</strong>
            </div>
            <progress value={progress} max={100} style={{ width: '100%' }} />
            <div className="muted small">{progress}%</div>
          </div>
        )}

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || label.trim().length === 0 || filesPicked.length === 0}
        >
          {busy ? 'Creating…' : 'Create send link'}
        </button>
      </form>
    </main>
  );
}

/**
 * Map a finalize outcome's failure branches into a user-facing string. We
 * already check `ok / completed` upstream; everything else funnels through
 * here. Policy rejections on the admin upload path are limited to `disabled`
 * by the admin-bypass in `upload-tickets.createForSendLink`.
 */
function describeFailure(
  outcome:
    | { kind: 'ok'; value: { status: 'completed' | 'failed'; reason?: string } }
    | { kind: 'policy_rejected'; reason: PolicyRejection }
    | { kind: 'not_found' }
    | { kind: 'error'; message: string },
): string {
  if (outcome.kind === 'ok' && outcome.value.status === 'failed') {
    return outcome.value.reason === 'object_not_found'
      ? 'The server could not verify your upload. Please try again.'
      : 'Upload failed during finalization.';
  }
  if (outcome.kind === 'not_found') return 'The upload ticket was not found.';
  if (outcome.kind === 'policy_rejected') return `Link policy rejected: ${outcome.reason}.`;
  if (outcome.kind === 'error') return outcome.message;
  return 'Unknown failure.';
}
