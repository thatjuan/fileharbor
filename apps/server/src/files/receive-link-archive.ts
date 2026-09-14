import { ZipArchive, type Archiver } from 'archiver';
import { PassThrough, Transform, type Readable } from 'node:stream';

import type { FileRecord } from './files.js';
import { logServerError } from '../http/errors.js';
import type { StorageProvider, StorageRead } from '../storage/index.js';

const MAX_ENTRY_NAME_BYTES = 200;

export interface ArchiveEntry {
  file: FileRecord;
  entryName: string;
}

export type ArchivePreparationErrorCode =
  | 'file_missing'
  | 'file_changed'
  | 'storage_unavailable'
  | 'internal_error';

export class ArchivePreparationError extends Error {
  constructor(readonly code: ArchivePreparationErrorCode) {
    super(code);
    this.name = 'ArchivePreparationError';
  }
}

/** Snapshot, order, sanitize, and de-duplicate the flat ZIP entry names. */
export function buildArchiveEntries(files: readonly FileRecord[]): ArchiveEntry[] {
  const allocated = new Set<string>();
  return [...files]
    .sort((left, right) => left.createdAt - right.createdAt || compareCodeUnits(left.id, right.id))
    .map((file) => {
      const sanitized = sanitizeEntryName(file.filename);
      let entryName = sanitized;
      let suffixNumber = 2;
      while (allocated.has(entryName.toLowerCase())) {
        entryName = withSuffix(sanitized, ` (${suffixNumber})`);
        suffixNumber += 1;
      }
      allocated.add(entryName.toLowerCase());
      return { file, entryName };
    });
}

/**
 * Prepare the first object, then stream the remaining objects one at a time
 * into a STORE-mode ZIP64 archive. The returned stream owns every source.
 */
export async function createReceiveLinkArchive(input: {
  receiveLinkId: string;
  files: readonly FileRecord[];
  storage: StorageProvider;
  signal: AbortSignal;
}): Promise<Readable> {
  const entries = buildArchiveEntries(input.files);
  const first = entries[0];
  if (!first) throw new ArchivePreparationError('internal_error');

  const controller = new AbortController();
  let activeSource: Readable | null = null;
  let archive: Archiver | null = null;
  let output: PassThrough | null = null;
  let settled = false;
  let firstEarlyError: unknown;
  let firstBodyWithTemporaryListener: Readable | null = null;
  const captureFirstEarlyError = (error: unknown): void => {
    firstEarlyError = error;
  };

  const cancel = (): void => {
    if (!controller.signal.aborted) controller.abort();
    firstBodyWithTemporaryListener?.off('error', captureFirstEarlyError);
    firstBodyWithTemporaryListener = null;
    activeSource?.destroy();
    activeSource = null;
    archive?.abort();
    archive?.destroy();
    output?.destroy();
  };
  input.signal.addEventListener('abort', cancel, { once: true });

  let firstRead: StorageRead;
  try {
    if (input.signal.aborted) throw abortError();
    const opened = await input.storage.openRead(first.file.s3Key, { signal: controller.signal });
    if (input.signal.aborted) {
      opened?.body.destroy();
      throw abortError();
    }
    if (!opened) throw new ArchivePreparationError('file_missing');
    if (opened.size !== first.file.size) {
      opened.body.destroy();
      throw new ArchivePreparationError('file_changed');
    }
    firstRead = opened;
    activeSource = opened.body;
    firstBodyWithTemporaryListener = opened.body;
    opened.body.once('error', captureFirstEarlyError);
  } catch (error: unknown) {
    firstBodyWithTemporaryListener?.off('error', captureFirstEarlyError);
    firstBodyWithTemporaryListener = null;
    input.signal.removeEventListener('abort', cancel);
    if (error instanceof ArchivePreparationError) {
      logArchiveError(input.receiveLinkId, first.file.id, error);
      throw error;
    }
    if (!isAbortError(error)) logArchiveError(input.receiveLinkId, first.file.id, error);
    throw new ArchivePreparationError(classifyPreparationError(error));
  }

  try {
    output = new PassThrough();
    archive = new ZipArchive({ forceZip64: true, store: true, zlib: { level: 0 } });
    archive.pipe(output);
  } catch (error: unknown) {
    firstRead.body.off('error', captureFirstEarlyError);
    firstBodyWithTemporaryListener = null;
    firstRead.body.destroy();
    input.signal.removeEventListener('abort', cancel);
    logArchiveError(input.receiveLinkId, first.file.id, error);
    throw new ArchivePreparationError('internal_error');
  }

  const cleanup = (): void => {
    input.signal.removeEventListener('abort', cancel);
    activeSource = null;
  };
  output.once('end', () => {
    settled = true;
    cleanup();
  });
  output.once('close', () => {
    if (!settled) cancel();
    cleanup();
  });
  archive.once('error', (error) => {
    if (!settled) output.destroy(error);
  });

  // Assigned before each open solely for safe error context.
  let activeSourceKey = first.file.s3Key;
  void produceArchive(entries, firstRead, input.storage, controller.signal, (source) => {
    activeSource = source;
  })
    .then(async () => {
      activeSource = null;
      await archive?.finalize();
    })
    .catch((error: unknown) => {
      const current =
        entries.find((entry) => entry.file.s3Key === activeSourceKey)?.file ?? first.file;
      if (!isAbortError(error)) logArchiveError(input.receiveLinkId, current.id, error);
      cancel();
      output.destroy(error instanceof Error ? error : new Error('archive_stream_failed'));
    });

  async function produceArchive(
    orderedEntries: readonly ArchiveEntry[],
    preparedFirst: StorageRead,
    storage: StorageProvider,
    signal: AbortSignal,
    setActive: (source: Readable | null) => void,
  ): Promise<void> {
    for (let index = 0; index < orderedEntries.length; index += 1) {
      const entry = orderedEntries[index];
      if (!entry) continue;
      activeSourceKey = entry.file.s3Key;
      if (signal.aborted) throw abortError();
      const opened =
        index === 0 ? preparedFirst : await storage.openRead(entry.file.s3Key, { signal });
      if (!opened) throw new Error('archive_file_missing');
      if (index === 0) {
        opened.body.off('error', captureFirstEarlyError);
        firstBodyWithTemporaryListener = null;
        if (firstEarlyError !== undefined) throw firstEarlyError;
      }
      if (opened.size !== entry.file.size) {
        opened.body.destroy();
        throw new Error('archive_file_changed');
      }

      const checked = createSizeCheckedStream(entry.file.size, opened.size);
      setActive(opened.body);
      const forwardSourceError = (error: Error): void => {
        checked.destroy(error);
      };
      opened.body.once('error', forwardSourceError);
      opened.body.pipe(checked);
      try {
        await appendAndWait(archive!, checked, entry.entryName, signal);
      } finally {
        opened.body.unpipe(checked);
        opened.body.off('error', forwardSourceError);
      }
      setActive(null);
    }
  }

  return output;
}

function appendAndWait(
  archive: Archiver,
  source: Readable,
  name: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: { name: string }): void => {
      if (entry.name !== name) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => {
      archive.off('entry', onEntry);
      archive.off('error', onError);
      source.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    archive.on('entry', onEntry);
    archive.once('error', onError);
    source.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    archive.append(source, { name, store: true });
  });
}

function createSizeCheckedStream(recordedSize: number, openedSize: number): Transform {
  let streamed = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      streamed += chunk.length;
      if (streamed > recordedSize || streamed > openedSize) {
        callback(new Error('archive_file_changed'));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (streamed !== recordedSize || streamed !== openedSize) {
        callback(new Error('archive_file_changed'));
        return;
      }
      callback();
    },
  });
}

function sanitizeEntryName(filename: string): string {
  let name = [...filename.normalize('NFKC')]
    .map((point) => {
      const code = point.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) || /[\\/<>:"|?*]/u.test(point) ? '_' : point;
    })
    .join('')
    .replace(/[. ]+$/u, '');
  if (name === '' || name === '.' || name === '..') name = 'file';

  const safeName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) ? `_${name}` : name;
  const { stem, extension } = splitExtension(safeName);
  return truncateParts(stem, extension, '');
}

function withSuffix(name: string, suffix: string): string {
  const { stem, extension } = splitExtension(name);
  return truncateParts(stem, extension, suffix);
}

function truncateParts(stem: string, extension: string, suffix: string): string {
  const extensionBudget = utf8Length(extension) < MAX_ENTRY_NAME_BYTES ? extension : '';
  const fixedBytes = utf8Length(suffix) + utf8Length(extensionBudget);
  const stemBudget = Math.max(1, MAX_ENTRY_NAME_BYTES - fixedBytes);
  const truncatedStem = truncateUtf8(stem, stemBudget) || 'f';
  return `${truncatedStem}${suffix}${extensionBudget}`;
}

function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const point of value) {
    const pointBytes = utf8Length(point);
    if (bytes + pointBytes > maxBytes) break;
    result += point;
    bytes += pointBytes;
  }
  return result;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function classifyPreparationError(error: unknown): ArchivePreparationErrorCode {
  if (isAbortError(error)) return 'storage_unavailable';
  if (
    error instanceof Error &&
    [
      'invalid_storage_key',
      'storage_object_not_regular_file',
      's3_invalid_get_object_response',
      's3_get_object_body_not_node_readable',
    ].includes(error.message)
  ) {
    return 'internal_error';
  }
  return 'storage_unavailable';
}

function logArchiveError(receiveLinkId: string, fileId: string, error: unknown): void {
  logServerError('receive_link_archive.failed', safeErrorCategory(error), {
    receiveLinkId,
    fileId,
  });
}

function safeErrorCategory(error: unknown): string {
  if (error instanceof ArchivePreparationError) return error.code;
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code)) return code;
  }
  if (error instanceof Error && /^[A-Za-z0-9_.-]{1,80}$/.test(error.message)) {
    return error.message;
  }
  return 'storage_error';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortError(): Error {
  const error = new Error('archive_aborted');
  error.name = 'AbortError';
  return error;
}
