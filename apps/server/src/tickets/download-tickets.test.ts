import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';

import { openDatabase } from '../db/client.js';
import { files, sendLinks } from '../db/schema.js';
import { createFilesModule } from '../files/files.js';
import { createSendLinksModule } from '../links/send-links.js';
import type { StorageProvider } from '../storage/index.js';
import { createDownloadTicketsModule } from './download-tickets.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../drizzle');

function unused(): never {
  throw new Error('unused');
}

/** Fake storage: only `presignGet` is reachable from the download-ticket mint. */
const storage: StorageProvider = {
  bucket: 'fake-s3',
  defaultTtlSeconds: 300,
  async presignGet() {
    return {
      url: `https://storage.example/get/${randomUUID()}`,
      expiresAt: new Date(Date.now() + 300_000),
    };
  },
  presignPut: unused,
  presignDelete: unused,
  headObject: unused,
  openRead: unused,
  deleteObject: unused,
  initMultipart: unused,
  presignUploadPart: unused,
  completeMultipart: unused,
  abortMultipart: unused,
};

/** One send link with one attached file, on a fresh in-memory database. */
async function setup(maxDownloads: number | null) {
  const db = openDatabase(':memory:', migrationsFolder);
  const sendLinksModule = createSendLinksModule(db, storage);
  const link = await sendLinksModule.create({ label: 'quota', maxDownloads });
  const fileId = randomUUID();
  db.insert(files)
    .values({
      id: fileId,
      s3Key: `send/${fileId}`,
      filename: 'report.pdf',
      contentType: 'application/pdf',
      size: 10,
      createdAt: Math.floor(Date.now() / 1000),
      sendLinkId: link.id,
    })
    .run();

  const tickets = createDownloadTicketsModule(db, storage, sendLinksModule, createFilesModule(db));
  const mint = () => tickets.createForSendLink({ linkCode: link.code, fileId });
  const downloadCount = () =>
    db.select({ n: sendLinks.downloadCount }).from(sendLinks).where(eq(sendLinks.id, link.id)).get()
      ?.n;
  return { tickets, mint, downloadCount };
}

test('mint reserves quota: a second unconfirmed mint is rejected', async () => {
  const { mint, downloadCount } = await setup(1);

  assert.equal((await mint()).kind, 'ok');
  assert.deepEqual(await mint(), {
    kind: 'policy_rejected',
    policy: { kind: 'quota_exhausted' },
  });
  assert.equal(downloadCount(), 1);
});

test('confirm failed does not refund the slot', async () => {
  const { tickets, mint, downloadCount } = await setup(1);

  const first = await mint();
  assert.equal(first.kind, 'ok');
  if (first.kind !== 'ok') return;
  assert.deepEqual(await tickets.confirm(first.value.ticketId, { outcome: 'failed' }), {
    kind: 'failed',
  });

  assert.deepEqual(await mint(), {
    kind: 'policy_rejected',
    policy: { kind: 'quota_exhausted' },
  });
  assert.equal(downloadCount(), 1);
});

test('unlimited links count every mint', async () => {
  const { mint, downloadCount } = await setup(null);

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await mint()).kind, 'ok');
  }
  assert.equal(downloadCount(), 5);
});

test('expire changes the ticket status but not the download count', async () => {
  const { tickets, mint, downloadCount } = await setup(null);

  const minted = await mint();
  assert.equal(minted.kind, 'ok');
  if (minted.kind !== 'ok') return;
  assert.equal(downloadCount(), 1);

  assert.deepEqual(await tickets.expire(minted.value.ticketId), { kind: 'expired' });
  assert.equal(downloadCount(), 1);
});
