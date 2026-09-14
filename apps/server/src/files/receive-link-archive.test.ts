import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import yauzl from 'yauzl';

import type { FileRecord } from './files.js';
import { buildArchiveEntries, createReceiveLinkArchive } from './receive-link-archive.js';
import type { StorageProvider } from '../storage/index.js';

function file(id: string, filename: string, bytes: Buffer, createdAt = 1): FileRecord {
  return {
    id,
    s3Key: `objects/${id}`,
    filename,
    contentType: 'application/octet-stream',
    size: bytes.length,
    createdAt,
    receiveLinkId: 'link-1',
    sendLinkId: null,
  };
}

function storageFor(openRead: StorageProvider['openRead']): StorageProvider {
  return { bucket: 'test', defaultTtlSeconds: 60, openRead } as unknown as StorageProvider;
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function unzip(buffer: Buffer): Promise<Array<{ name: string; bytes: Buffer }>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error('zip_open_failed'));
        return;
      }
      const entries: Array<{ name: string; bytes: Buffer }> = [];
      zip.once('error', reject);
      zip.once('end', () => resolve(entries));
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('zip_entry_open_failed'));
            return;
          }
          collect(stream)
            .then((bytes) => {
              entries.push({ name: entry.fileName, bytes });
              zip.readEntry();
            })
            .catch(reject);
        });
      });
      zip.readEntry();
    });
  });
}

test('streams ordered files, including zero bytes, into a forced-ZIP64 archive', async () => {
  const contents = new Map([
    ['objects/a', Buffer.from('alpha')],
    ['objects/z', Buffer.alloc(0)],
  ]);
  const files = [
    file('z', 'empty.txt', contents.get('objects/z')!, 2),
    file('a', 'a.txt', contents.get('objects/a')!, 1),
  ];
  const archive = await createReceiveLinkArchive({
    receiveLinkId: 'link-1',
    files,
    storage: storageFor(async (key) => {
      const bytes = contents.get(key);
      return bytes ? { body: Readable.from(bytes), size: bytes.length } : null;
    }),
    signal: new AbortController().signal,
  });
  const zipBytes = await collect(archive);
  const extracted = await unzip(zipBytes);
  assert.deepEqual(
    extracted.map((entry) => entry.name),
    ['a.txt', 'empty.txt'],
  );
  assert.deepEqual(
    extracted.map((entry) => entry.bytes),
    [Buffer.from('alpha'), Buffer.alloc(0)],
  );
  assert.notEqual(zipBytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])), -1);
  assert.notEqual(zipBytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07])), -1);
});

test('entry names are safe, bounded, deterministic, and collision-free', () => {
  const long = `${'😀'.repeat(100)}.txt`;
  const files = [
    file('4', 'report (2).pdf', Buffer.alloc(0), 1),
    file('3', 'REPORT.PDF', Buffer.alloc(0), 1),
    file('2', 'report.pdf', Buffer.alloc(0), 1),
    file('1', 'report.pdf', Buffer.alloc(0), 1),
    file('5', '../CON ', Buffer.alloc(0), 2),
    file('6', 'a/b\\c\u0000.txt', Buffer.alloc(0), 2),
    file('7', long, Buffer.alloc(0), 2),
    file('8', long, Buffer.alloc(0), 2),
    file('9', 'CON.backup.txt', Buffer.alloc(0), 2),
  ];
  const names = buildArchiveEntries(files).map((entry) => entry.entryName);
  assert.deepEqual(names.slice(0, 4), [
    'report.pdf',
    'report (2).pdf',
    'REPORT (3).PDF',
    'report (2) (2).pdf',
  ]);
  assert.equal(names[4], '.._CON');
  assert.equal(names[5], 'a_b_c_.txt');
  assert.equal(names[8], '_CON.backup.txt');
  assert.ok(names.every((name) => Buffer.byteLength(name) <= 200));
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);
});

test('opens one storage source at a time under a slow consumer', async () => {
  let active = 0;
  let maximum = 0;
  const files = [
    file('1', 'one.bin', Buffer.alloc(512 * 1024)),
    file('2', 'two.bin', Buffer.alloc(512 * 1024), 2),
  ];
  const archive = await createReceiveLinkArchive({
    receiveLinkId: 'link-1',
    files,
    storage: storageFor(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      const body = Readable.from(
        (async function* () {
          try {
            for (let index = 0; index < 8; index += 1) yield Buffer.alloc(64 * 1024);
          } finally {
            active -= 1;
          }
        })(),
      );
      return { body, size: 512 * 1024 };
    }),
    signal: new AbortController().signal,
  });
  for await (const _chunk of archive) await delay(1);
  assert.equal(maximum, 1);
});

test('cancellation destroys the active source and never opens the next object', async () => {
  const source = new PassThrough();
  let opens = 0;
  const controller = new AbortController();
  const archive = await createReceiveLinkArchive({
    receiveLinkId: 'link-1',
    files: [file('1', 'one.bin', Buffer.alloc(4)), file('2', 'two.bin', Buffer.alloc(4), 2)],
    storage: storageFor(async () => {
      opens += 1;
      return { body: source, size: 4 };
    }),
    signal: controller.signal,
  });
  archive.resume();
  controller.abort();
  await delay(0);
  assert.equal(source.destroyed, true);
  assert.equal(source.listenerCount('error'), 0);
  assert.equal(opens, 1);
});

test('cancellation while the initial storage open is pending safely closes the late source', async () => {
  const source = new PassThrough();
  let resolveOpen: ((value: { body: Readable; size: number }) => void) | undefined;
  const openingGate = new Promise<{ body: Readable; size: number }>((resolve) => {
    resolveOpen = resolve;
  });
  const controller = new AbortController();
  const creating = createReceiveLinkArchive({
    receiveLinkId: 'link-1',
    files: [file('1', 'one.bin', Buffer.alloc(4))],
    storage: storageFor(async () => openingGate),
    signal: controller.signal,
  });

  controller.abort();
  resolveOpen?.({ body: source, size: 4 });
  await assert.rejects(creating, { name: 'ArchivePreparationError' });
  assert.equal(source.destroyed, true);
  assert.equal(source.listenerCount('error'), 0);
});

for (const scenario of ['missing', 'read-error', 'short'] as const) {
  test(`${scenario} later object prevents successful archive finalization`, async () => {
    let calls = 0;
    const archive = await createReceiveLinkArchive({
      receiveLinkId: 'link-1',
      files: [file('1', 'one.txt', Buffer.from('a')), file('2', 'two.txt', Buffer.from('bb'), 2)],
      storage: storageFor(async () => {
        calls += 1;
        if (calls === 1) return { body: Readable.from('a'), size: 1 };
        if (scenario === 'missing') return null;
        if (scenario === 'short') return { body: Readable.from('b'), size: 2 };
        return {
          body: new Readable({
            read() {
              this.destroy(new Error('provider_read_failed'));
            },
          }),
          size: 2,
        };
      }),
      signal: new AbortController().signal,
    });
    await assert.rejects(collect(archive));
  });
}
