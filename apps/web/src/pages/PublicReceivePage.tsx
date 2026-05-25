import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useParams } from 'react-router-dom';

import {
  createUploadTicket,
  finalizeUploadTicket,
  getPublicReceiveLink,
  type PublicReceiveLink,
} from '../lib/api.js';
import { uploadFileWithProgress } from '../lib/upload.js';

/**
 * Public upload page (`/r/:code`). Unauthenticated. The whole flow:
 *
 *   1. On mount: fetch `/api/public/receive-links/:code` for the label.
 *      A 404 means "bad code or disabled" — same shape so we can't be probed.
 *   2. User picks a file.
 *   3. Mint a ticket via the public API. Receive a presigned PUT URL.
 *   4. PUT the file directly to S3 with XHR progress tracking.
 *   5. POST to the finalize endpoint. Server HEADs the bucket.
 *   6. Show "complete" or "failed" based on the finalize result.
 */
export function PublicReceivePage(): JSX.Element {
  const params = useParams<{ code: string }>();
  const code = params.code ?? '';

  const [meta, setMeta] = useState<PublicReceiveLink | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [phase, setPhase] = useState<
    'idle' | 'minting' | 'uploading' | 'finalizing' | 'completed' | 'failed'
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
      });

      // Step 2: PUT to S3 with progress.
      setPhase('uploading');
      const putResult = await uploadFileWithProgress({
        url: ticket.presignedPutUrl,
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

      // Step 3: finalize (server HEADs the bucket).
      setPhase('finalizing');
      const finalizeResult = await finalizeUploadTicket(ticket.ticketId);

      if (finalizeResult.status === 'completed') {
        setPhase('completed');
        setCompletedName(file.name);
      } else {
        setPhase('failed');
        setError(
          finalizeResult.reason === 'object_not_found'
            ? 'The server could not verify your upload. Please try again.'
            : 'Upload failed during finalization.',
        );
      }
    } catch (err) {
      setPhase('failed');
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      // Reset the input so the user can pick the same file again after a
      // failure without weirdness.
      if (fileInputRef.current) fileInputRef.current.value = '';
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

      {phase !== 'completed' && (
        <div className="stack">
          <label>
            Pick a file
            <input ref={fileInputRef} type="file" onChange={onFileChange} disabled={busy} />
          </label>

          {phase === 'minting' && <p className="muted">Preparing upload…</p>}

          {phase === 'uploading' && (
            <div>
              <progress value={progress} max={100} style={{ width: '100%' }} />
              <div className="muted small">{progress}%</div>
            </div>
          )}

          {phase === 'finalizing' && <p className="muted">Confirming with server…</p>}

          {phase === 'failed' && error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
