import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { createSendLink, finalizeUploadTicket, type PolicyRejection } from '../lib/api.js';
import { uploadFileWithProgress } from '../lib/upload.js';

/**
 * Form to create a new send link. The flow is:
 *
 *   1. Admin enters a label and picks a file. The form keeps the file in
 *      state until submit so we can validate both fields together.
 *   2. On submit, `POST /api/send-links` with the label + file metadata.
 *      The server mints the link AND the first upload-ticket in one shot.
 *   3. PUT the file directly to the presigned URL with XHR progress (reuses
 *      `lib/upload.ts`, same as the receive flow).
 *   4. POST `/api/public/upload-tickets/:ticketId/finalize` so the server
 *      HEADs the bucket and creates the `file` row bound to the send link.
 *   5. Redirect to `/links/send/:id`.
 *
 * If finalize fails the link still exists on the server. #12 will let the
 * admin clean those up; for now we surface the error so the operator knows.
 */
export function NewSendLinkPage(): JSX.Element {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<'idle' | 'creating' | 'uploading' | 'finalizing'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const onFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setFile(e.target.files?.[0] ?? null);
  };

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!file) {
      setError('Pick a file to share.');
      return;
    }

    setError(null);
    setProgress(0);

    // Browsers occasionally hand back `''` for `file.type`. The server falls
    // back to `application/octet-stream`; we mirror that client-side so the
    // `Content-Type` header we PUT matches what got signed into the URL.
    const contentType = file.type || 'application/octet-stream';

    try {
      setPhase('creating');
      const { link, ticket } = await createSendLink({
        label: label.trim(),
        filename: file.name,
        contentType,
        size: file.size,
      });

      setPhase('uploading');
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
          `Upload to storage failed (status=${putResult.status}). Please retry from the dashboard.`,
        );
      }
      setProgress(100);

      setPhase('finalizing');
      const outcome = await finalizeUploadTicket(ticket.ticketId, null);
      if (outcome.kind !== 'ok' || outcome.value.status !== 'completed') {
        throw new Error(describeFailure(outcome));
      }

      navigate(`/links/send/${link.id}`, { replace: true });
    } catch (err) {
      setPhase('idle');
      setError(err instanceof Error ? err.message : 'Failed to create send link.');
    }
  };

  const busy = phase !== 'idle';

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
          File
          <input ref={fileInputRef} type="file" onChange={onFileChange} disabled={busy} required />
        </label>

        {phase === 'creating' && <p className="muted">Preparing link…</p>}
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
        <button type="submit" disabled={busy || label.trim().length === 0 || !file}>
          {busy ? 'Creating…' : 'Create send link'}
        </button>
      </form>
    </main>
  );
}

/**
 * Map a finalize outcome's failure branches into a user-facing string. We
 * already check `ok / completed` upstream; everything else funnels through
 * here. Policy rejections are unusual in #8 (no password/quota/expiry on send
 * links yet) but the server runs the full policy module — leaving the
 * branches here keeps the page robust to #11.
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
