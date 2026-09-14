export type ReceiveUploadStatus =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'confirming'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'not_started';

export type ReceiveUploadActiveStatus = Extract<
  ReceiveUploadStatus,
  'preparing' | 'uploading' | 'confirming'
>;

export interface ReceiveUploadEntry<T> {
  id: string;
  value: T;
  status: ReceiveUploadStatus;
  error?: string;
}

export type ReceiveUploadFailureKind = 'ordinary' | 'password' | 'terminal';

export type ReceiveUploadAttemptResult =
  | { kind: 'completed' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string; failureKind: ReceiveUploadFailureKind };

export type ReceiveUploadQueueResult<T> =
  | { kind: 'completed'; entries: ReceiveUploadEntry<T>[] }
  | { kind: 'cancelled'; entries: ReceiveUploadEntry<T>[] }
  | {
      kind: 'failed';
      entries: ReceiveUploadEntry<T>[];
      error: string;
      failureKind: ReceiveUploadFailureKind;
    };

interface RunReceiveUploadQueueInput<T> {
  entries: readonly ReceiveUploadEntry<T>[];
  signal: AbortSignal;
  attempt(
    entry: ReceiveUploadEntry<T>,
    setStatus: (status: ReceiveUploadActiveStatus) => void,
  ): Promise<ReceiveUploadAttemptResult>;
  onChange?(entries: ReceiveUploadEntry<T>[]): void;
}

let nextEntryId = 0;

/** Creates distinct, stable queue entries without using the filename as identity. */
export function createReceiveUploadEntries<T>(values: readonly T[]): ReceiveUploadEntry<T>[] {
  return values.map((value) => ({
    id: `receive-upload-${nextEntryId++}`,
    value,
    status: 'queued',
  }));
}

/**
 * Runs one upload attempt at a time. Ordinary per-file failures are skipped;
 * password and terminal policy failures stop the queue because later attempts
 * cannot recover. Cancellation always stops. A successful attempt remains
 * completed even when cancellation was requested while it was confirming.
 */
export async function runReceiveUploadQueue<T>(
  input: RunReceiveUploadQueueInput<T>,
): Promise<ReceiveUploadQueueResult<T>> {
  const entries = input.entries.map((entry) => ({ ...entry }));
  let firstOrdinaryFailure: ReceiveUploadAttemptResult | null = null;
  const emit = (): void => input.onChange?.(entries.map((entry) => ({ ...entry })));
  const leaveRemainingUnstarted = (from: number): void => {
    for (let index = from; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry?.status === 'queued') entry.status = 'not_started';
    }
  };

  emit();

  for (let index = 0; index < entries.length; index += 1) {
    if (input.signal.aborted) {
      leaveRemainingUnstarted(index);
      emit();
      return { kind: 'cancelled', entries };
    }

    const entry = entries[index];
    if (!entry) continue;
    entry.status = 'preparing';
    emit();

    let settled = false;
    const result = await input.attempt(entry, (status) => {
      if (settled) return;
      entry.status = status;
      emit();
    });
    settled = true;

    if (result.kind === 'completed') {
      entry.status = 'completed';
      delete entry.error;
      emit();

      if (input.signal.aborted) {
        leaveRemainingUnstarted(index + 1);
        emit();
        return { kind: 'cancelled', entries };
      }
      continue;
    }

    if (result.kind === 'cancelled') {
      entry.status = 'cancelled';
      leaveRemainingUnstarted(index + 1);
      emit();
      return { kind: 'cancelled', entries };
    }

    entry.status = 'failed';
    entry.error = result.error;
    emit();

    if (result.failureKind === 'ordinary') {
      firstOrdinaryFailure ??= result;
      continue;
    }

    leaveRemainingUnstarted(index + 1);
    emit();
    return {
      kind: 'failed',
      entries,
      error: result.error,
      failureKind: result.failureKind,
    };
  }

  if (firstOrdinaryFailure?.kind === 'failed') {
    return {
      kind: 'failed',
      entries,
      error: firstOrdinaryFailure.error,
      failureKind: 'ordinary',
    };
  }
  return { kind: 'completed', entries };
}
