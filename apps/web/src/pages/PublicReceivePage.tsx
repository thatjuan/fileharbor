import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import { useParams } from 'react-router-dom';

import {
  AnchorIcon,
  CheckIcon,
  LinkIcon,
  LockIcon,
  UploadIcon,
  XIcon,
} from '../components/Icons.js';
import { LanguageSwitcher, Trans, mapUploadErrorMessage, useT } from '../i18n/index.js';
import { ThemeSwitcher } from '../theme/ThemeSwitcher.js';
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
import {
  createReceiveUploadEntries,
  runReceiveUploadQueue,
  type ReceiveUploadActiveStatus,
  type ReceiveUploadAttemptResult,
  type ReceiveUploadEntry,
  type ReceiveUploadStatus,
} from '../lib/receive-upload-queue.js';
import { uploadFile, type UploadFinalizeOutcome } from '../lib/upload.js';
import { DEFAULT_UPLOAD_CONFIG, getUploadConfig, type UploadConfig } from '../lib/upload-config.js';

type PagePhase =
  | 'idle'
  | 'preparing'
  | 'uploading'
  | 'confirming'
  | 'completed'
  | 'failed'
  | 'locked'
  | 'cancelling'
  | 'cancelled';

/**
 * Public upload page (`/r/:code`). Unauthenticated. Visitors select or drop a
 * batch, then each file independently follows the existing ticket, upload,
 * and finalize flow. The queue is deliberately serial so server-side link
 * policy remains authoritative for every file.
 */
export function PublicReceivePage(): JSX.Element {
  const params = useParams<{ code: string }>();
  const code = params.code ?? '';
  const t = useT();

  const [meta, setMeta] = useState<PublicReceiveLink | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [uploadConfig, setUploadConfig] = useState<UploadConfig | null>(null);
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<PagePhase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<ReceiveUploadEntry<File>[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  // React state is not synchronous, so this ref is the admission lock for two
  // picker/drop events arriving before the busy phase renders.
  const admissionRef = useRef(false);
  const terminalLockRef = useRef(false);
  // Invalidates callbacks from an upload belonging to an old receive code or
  // an unmounted page.
  const runIdRef = useRef(0);

  useEffect(() => {
    const pageRunId = ++runIdRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    admissionRef.current = false;
    terminalLockRef.current = false;
    setMeta(null);
    setMetaError(null);
    setUploadConfig(null);
    setPassword('');
    setPhase('idle');
    setProgress(0);
    setError(null);
    setEntries([]);
    setActiveIndex(null);

    Promise.all([getPublicReceiveLink(code), getUploadConfig()])
      .then(([nextMeta, nextConfig]) => {
        if (runIdRef.current !== pageRunId) return;
        setMeta(nextMeta);
        setUploadConfig(nextConfig);
      })
      .catch((err: unknown) => {
        if (runIdRef.current !== pageRunId) return;
        setUploadConfig((previous) => previous ?? DEFAULT_UPLOAD_CONFIG);
        setMetaError(err instanceof Error ? err.message : t('receive.notAvailable'));
      });

    return () => {
      if (runIdRef.current === pageRunId) runIdRef.current += 1;
      admissionRef.current = false;
      terminalLockRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [code]);

  const runFileAttempt = async (
    file: File,
    passwordForBatch: string | null,
    config: UploadConfig,
    controller: AbortController,
    setStatus: (status: ReceiveUploadActiveStatus) => void,
    updateProgress: (value: number) => void,
  ): Promise<ReceiveUploadAttemptResult> => {
    const contentType = file.type || 'application/octet-stream';
    let rejectedAttempt: ReceiveUploadAttemptResult | null = null;

    try {
      const result = await uploadFile({
        file,
        contentType,
        threshold: config.multipartThresholdBytes,
        partSizeBytes: config.multipartPartSizeBytes,
        single: {
          presign: async () => {
            setStatus('preparing');
            const ticket = await createUploadTicket(code, {
              filename: file.name,
              contentType,
              size: file.size,
              password: passwordForBatch,
            });
            if (ticket.kind !== 'ok') {
              throw new AttemptRejected(toAttemptFailure(ticket, t));
            }
            setStatus('uploading');
            return {
              presignedPutUrl: ticket.value.presignedPutUrl,
              ticketId: ticket.value.ticketId,
            };
          },
          finalize: async (ticketId) => {
            setStatus('confirming');
            const outcome = await finalizeUploadTicket(ticketId, passwordForBatch);
            return adaptFinalizeOutcome(outcome);
          },
        },
        multipart: {
          init: async () => {
            setStatus('preparing');
            const outcome = await createMultipartUploadTicket(code, {
              filename: file.name,
              contentType,
              size: file.size,
              password: passwordForBatch,
            });
            if (outcome.kind !== 'ok') {
              rejectedAttempt = toAttemptFailure(outcome, t);
              throw new Error('Multipart ticket rejected.');
            }
            setStatus('uploading');
            return {
              ticketId: outcome.value.ticketId,
              uploadId: outcome.value.uploadId,
              partSize: outcome.value.partSize,
              expectedParts: outcome.value.expectedParts,
              initialUrls: outcome.value.initialUrls,
              paginated: outcome.value.paginated,
            };
          },
          fetchPartUrls: async (ticketId, from, to) => {
            const outcome = await fetchMultipartPartUrls(ticketId, from, to, passwordForBatch);
            if (outcome.kind !== 'ok') {
              rejectedAttempt = toAttemptFailure(outcome, t);
              throw new Error('Multipart part URLs rejected.');
            }
            return outcome.value.urls;
          },
          complete: async (ticketId, parts) => {
            setStatus('confirming');
            const outcome = await completeMultipartUploadTicket(ticketId, {
              parts,
              password: passwordForBatch,
            });
            return adaptFinalizeOutcome(outcome);
          },
          abort: (ticketId) => abortMultipartUploadTicket(ticketId, passwordForBatch),
        },
        onProgress: ({ loaded, total }) => {
          if (total > 0) updateProgress(Math.round((loaded / total) * 100));
        },
        signal: controller.signal,
      });

      const outcome = result.outcome;
      if (outcome.kind === 'ok') return { kind: 'completed' };

      // A successful finalization wins over a cancellation requested while it
      // was in flight. Every other settled result becomes a soft cancellation.
      if (controller.signal.aborted) return { kind: 'cancelled' };
      if (rejectedAttempt) return rejectedAttempt;

      if (outcome.kind === 'failed') {
        return {
          kind: 'failed',
          failureKind: 'ordinary',
          error:
            outcome.reason === 'object_not_found'
              ? t('errors.uploadObjectNotFound')
              : outcome.reason.length > 0
                ? t('errors.uploadFailedReason', { reason: outcome.reason })
                : t('errors.uploadFailedFinalize'),
        };
      }
      if (outcome.kind === 'policy_rejected') {
        const rejection = asKnownPolicyRejection(outcome.reason);
        return rejection === null
          ? {
              kind: 'failed',
              failureKind: 'ordinary',
              error: t('errors.uploadRejectedReason', { reason: outcome.reason }),
            }
          : toAttemptFailure({ kind: 'policy_rejected', reason: rejection }, t);
      }
      return toAttemptFailure(outcome, t);
    } catch (err) {
      if (controller.signal.aborted) return { kind: 'cancelled' };
      if (err instanceof AttemptRejected) return err.result;
      if (rejectedAttempt) return rejectedAttempt;
      return {
        kind: 'failed',
        failureKind: 'ordinary',
        error:
          err instanceof Error
            ? t(mapUploadErrorMessage(err.message))
            : t('errors.uploadFailedGeneric'),
      };
    }
  };

  const startBatch = (files: File[]): boolean => {
    if (
      files.length === 0 ||
      admissionRef.current ||
      terminalLockRef.current ||
      !meta ||
      !uploadConfig ||
      phase === 'locked' ||
      (meta.passwordRequired && password.length === 0)
    ) {
      return false;
    }

    admissionRef.current = true;
    const batchRunId = runIdRef.current;
    const passwordForBatch = meta.passwordRequired ? password : null;
    const controller = new AbortController();
    abortRef.current = controller;
    const initialEntries = createReceiveUploadEntries(files);

    setEntries(initialEntries);
    setError(null);
    setProgress(0);
    setActiveIndex(null);
    setPhase('preparing');

    const isCurrent = (): boolean => runIdRef.current === batchRunId;
    void runReceiveUploadQueue({
      entries: initialEntries,
      signal: controller.signal,
      onChange: (nextEntries) => {
        if (isCurrent()) setEntries(nextEntries);
      },
      attempt: async (entry, setStatus) => {
        const index = initialEntries.findIndex((candidate) => candidate.id === entry.id);
        if (isCurrent()) {
          setActiveIndex(index);
          setProgress(0);
        }
        return runFileAttempt(
          entry.value,
          passwordForBatch,
          uploadConfig,
          controller,
          (status) => {
            setStatus(status);
            if (isCurrent() && !controller.signal.aborted) setPhase(status);
          },
          (value) => {
            if (isCurrent()) setProgress(value);
          },
        );
      },
    })
      .then((result) => {
        if (!isCurrent()) return;
        setEntries(result.entries);
        setActiveIndex(null);
        if (result.kind === 'completed') {
          setPhase('completed');
          setProgress(100);
        } else if (result.kind === 'cancelled') {
          setPhase('cancelled');
          setProgress(0);
        } else {
          if (result.failureKind === 'terminal') terminalLockRef.current = true;
          setPhase(result.failureKind === 'terminal' ? 'locked' : 'failed');
          setError(result.error);
        }
      })
      .finally(() => {
        if (!isCurrent()) return;
        admissionRef.current = false;
        if (abortRef.current === controller) abortRef.current = null;
      });

    return true;
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    // FileList is a live browser object. Copy it before any upload can await.
    const files = Array.from(event.target.files ?? []);
    if (startBatch(files)) event.target.value = '';
  };

  const onCancel = (): void => {
    const controller = abortRef.current;
    if (!admissionRef.current || !controller || controller.signal.aborted) return;
    setPhase('cancelling');
    controller.abort();
  };

  if (metaError) {
    return (
      <PublicShell>
        <div className="public-header">
          <h1>{t('receive.title')}</h1>
        </div>
        <p role="alert" className="notice notice-danger">
          {t('receive.notAvailable')}
        </p>
      </PublicShell>
    );
  }

  if (!meta || !uploadConfig) {
    return (
      <PublicShell>
        <p className="muted">{t('common.loading')}</p>
      </PublicShell>
    );
  }

  const busy =
    phase === 'preparing' ||
    phase === 'uploading' ||
    phase === 'confirming' ||
    phase === 'cancelling';
  const cancellable = phase === 'preparing' || phase === 'uploading' || phase === 'confirming';
  const passwordReady = !meta.passwordRequired || password.length > 0;
  const pickerDisabled = busy || phase === 'locked' || !passwordReady;
  const completedCount = entries.filter((entry) => entry.status === 'completed').length;
  const activeEntry = activeIndex === null ? null : entries[activeIndex];

  const onDragOver = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    if (pickerDisabled) return;
    if (!isDragging) setIsDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLLabelElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    setIsDragging(false);
    if (pickerDisabled) return;
    // Preserve the order supplied by DataTransfer; do not sort or deduplicate.
    startBatch(Array.from(event.dataTransfer.files ?? []));
  };

  return (
    <PublicShell>
      <div className="public-header">
        <h1>{meta.label}</h1>
        <p className="muted">
          <Trans k="receive.invitedTo" components={{ label: <strong>{meta.label}</strong> }} />
        </p>
      </div>

      <div className="meta-strip">
        <div className="meta-item">
          <span className="meta-label">
            <LinkIcon size={11} />
            {t('meta.link')}
          </span>
          <span className="meta-value">/r/{code}</span>
        </div>
        {meta.passwordRequired && (
          <div className="meta-item">
            <span className="meta-label">
              <LockIcon size={11} />
              {t('meta.password')}
            </span>
            <span className="meta-value">{t('receive.password')}</span>
          </div>
        )}
      </div>

      <div className="stack">
        {meta.passwordRequired && phase !== 'locked' && (
          <div className="card">
            <label className="field">
              <span className="field-label">{t('receive.password')}</span>
              <input
                type="password"
                className="input"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (error) setError(null);
                }}
                disabled={busy}
                autoComplete="off"
                autoFocus
              />
            </label>
          </div>
        )}

        {!busy && phase !== 'locked' && (
          <label
            className={`dropzone${isDragging ? ' dropzone-active' : ''}`}
            aria-disabled={pickerDisabled}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <UploadIcon size={30} className="dropzone-icon" />
            <span className="dropzone-title">{t('receive.pickFiles')}</span>
            <span className="dropzone-hint">{t('receive.dropFilesHint')}</span>
            <input
              type="file"
              multiple
              className="sr-only"
              onChange={onFileChange}
              disabled={pickerDisabled}
            />
          </label>
        )}

        {entries.length > 0 && (
          <>
            <div className="receive-batch-summary" role="status" aria-live="polite">
              {activeEntry && (
                <p>
                  {t(activePhaseKey(phase), {
                    current: (activeIndex ?? 0) + 1,
                    total: entries.length,
                    name: activeEntry.value.name,
                  })}
                </p>
              )}
              <p className="muted small">
                {t('receive.batchProgress', {
                  completed: completedCount,
                  total: entries.length,
                })}
              </p>
            </div>

            {activeEntry && busy && (
              <div className="progress">
                <div className="progress-meta">
                  <span className="receive-progress-name">{activeEntry.value.name}</span>
                  <span>{progress}%</span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}

            <ul className="receive-upload-list" aria-label={t('receive.selectedFiles')}>
              {entries.map((entry) => (
                <li key={entry.id} className="receive-upload-row">
                  <span className="receive-upload-name">{entry.value.name}</span>
                  <span className={`receive-upload-status receive-upload-status-${entry.status}`}>
                    {t(statusKey(entry.status))}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {phase === 'completed' && entries.length > 0 && completedCount === entries.length && (
          <div className="notice">
            <CheckIcon size={16} className="accent" />
            <p role="status">{t('receive.allUploadsComplete')}</p>
          </div>
        )}

        {phase === 'cancelled' && <p className="notice notice-warning">{t('receive.cancelled')}</p>}

        {phase === 'locked' && (
          <p role="alert" className="notice notice-warning">
            {error ?? t('receive.lockedDefault')}
          </p>
        )}

        {error && phase !== 'locked' && (
          <div className="stack">
            <p role="alert" className="notice notice-danger">
              {error}
            </p>
            <p className="muted small">{t('receive.reselectIncomplete')}</p>
          </div>
        )}

        {cancellable && (
          <div className="row-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              <XIcon size={13} />
              {t('receive.cancelUploads')}
            </button>
          </div>
        )}
      </div>
    </PublicShell>
  );
}

function PublicShell({ children }: { children: ReactNode }): JSX.Element {
  const t = useT();
  return (
    <div className="public-page">
      <nav className="public-nav">
        <div className="public-nav-inner">
          <span className="top-nav-brand">
            <AnchorIcon size={22} className="top-nav-brand-mark" />
            <span className="top-nav-brand-text">
              File Harbor
              <span className="top-nav-brand-tag">self-hosted file send/receive</span>
            </span>
          </span>
          <div className="public-nav-tools">
            <ThemeSwitcher />
            <LanguageSwitcher />
          </div>
        </div>
      </nav>
      <main className="public-main">
        <div className="public-column">{children}</div>
      </main>
      <div className="public-footer">{t('footer.poweredBy')}</div>
    </div>
  );
}

class AttemptRejected extends Error {
  public readonly result: ReceiveUploadAttemptResult;

  public constructor(result: ReceiveUploadAttemptResult) {
    super('Upload attempt rejected.');
    this.name = 'AttemptRejected';
    this.result = result;
  }
}

type RejectionOutcome =
  | { kind: 'policy_rejected'; reason: PolicyRejection }
  | { kind: 'not_found' }
  | { kind: 'wrong_state' }
  | { kind: 'invalid_range' }
  | { kind: 'error'; message: string };

function toAttemptFailure(
  outcome: RejectionOutcome,
  t: (key: string, vars?: Record<string, string | number>) => string,
): ReceiveUploadAttemptResult {
  if (outcome.kind === 'not_found') {
    return { kind: 'failed', failureKind: 'terminal', error: t('receive.lockedDefault') };
  }
  if (outcome.kind === 'error') {
    return {
      kind: 'failed',
      failureKind: 'ordinary',
      error: t(mapUploadErrorMessage(outcome.message)),
    };
  }
  if (outcome.kind === 'wrong_state' || outcome.kind === 'invalid_range') {
    return {
      kind: 'failed',
      failureKind: 'ordinary',
      error: t('errors.uploadFailedGeneric'),
    };
  }

  switch (outcome.reason) {
    case 'password_required':
      return {
        kind: 'failed',
        failureKind: 'password',
        error: t('errors.passwordRequiredReceive'),
      };
    case 'password_wrong':
      return { kind: 'failed', failureKind: 'password', error: t('errors.passwordWrong') };
    case 'quota_exhausted':
      return {
        kind: 'failed',
        failureKind: 'terminal',
        error: t('errors.quotaExhaustedReceive'),
      };
    case 'expired':
      return { kind: 'failed', failureKind: 'terminal', error: t('errors.expired') };
    case 'disabled':
      return { kind: 'failed', failureKind: 'terminal', error: t('errors.disabled') };
  }
}

function activePhaseKey(phase: PagePhase): string {
  switch (phase) {
    case 'preparing':
      return 'receive.activePreparing';
    case 'confirming':
      return 'receive.activeConfirming';
    case 'cancelling':
      return 'receive.activeCancelling';
    default:
      return 'receive.activeUploading';
  }
}

function statusKey(status: ReceiveUploadStatus): string {
  switch (status) {
    case 'queued':
      return 'receive.statusQueued';
    case 'preparing':
      return 'receive.statusPreparing';
    case 'uploading':
      return 'receive.statusUploading';
    case 'confirming':
      return 'receive.statusConfirming';
    case 'completed':
      return 'receive.statusCompleted';
    case 'failed':
      return 'receive.statusFailed';
    case 'cancelled':
      return 'receive.statusCancelled';
    case 'not_started':
      return 'receive.statusNotStarted';
  }
}

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
