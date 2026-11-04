import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';

import { openDatabase } from '../db/client.js';
import { uploadTickets } from '../db/schema.js';
import { createFilesModule } from '../files/files.js';
import { createReceiveLinksModule } from '../links/receive-links.js';
import { createSendLinksModule } from '../links/send-links.js';
import { createLocalStorageProvider } from '../storage/local.js';
import { createDownloadTicketsModule } from './download-tickets.js';
import { createTicketSweeper } from './sweep.js';
import { createUploadTicketsModule, type FreeSpaceFloor } from './upload-tickets.js';

/**
 * Storage reclamation (#74): bytes that never become a `files` row are
 * deleted by the sweep or by link deletion. Runs against an in-memory
 * database and the real local storage provider in a temp dir.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../drizzle');

const PRESIGN_TTL = 60;
const GRACE = 30;
const RETENTION = 3600;
const MULTIPART_TTL = 7200;
const PART_SIZE = 8;

const notificationsModule = {
  async record() {
    return 'notification-id';
  },
  async list() {
    return [];
  },
  async unreadCount() {
    return 0;
  },
  async markRead() {
    return 0;
  },
  async markAllRead() {
    return 0;
  },
};

/** Wire every module against a fresh database and objects dir. */
function setup(freeSpaceFloor?: FreeSpaceFloor) {
  const objectsDir = mkdtempSync(join(tmpdir(), 'fileharbor-sweep-'));
  const db = openDatabase(':memory:', migrationsFolder);
  const multipart = {
    thresholdBytes: 1,
    partSizeBytes: PART_SIZE,
    ttlSeconds: MULTIPART_TTL,
    maxObjectSizeBytes: 1024,
  };
  const storage = createLocalStorageProvider({
    backend: 'local',
    objectsDir,
    signingSecret: 'secret',
    presignTtlSeconds: PRESIGN_TTL,
    minFreeBytes: 0,
    multipart,
  });
  const receiveLinksModule = createReceiveLinksModule(db, storage);
  const sendLinksModule = createSendLinksModule(db, storage);
  const filesModule = createFilesModule(db);
  const uploadTicketsModule = createUploadTicketsModule(
    db,
    storage,
    receiveLinksModule,
    sendLinksModule,
    filesModule,
    notificationsModule,
    multipart,
    { freeSpaceFloor },
  );
  const sweeper = createTicketSweeper({
    db,
    downloadTicketsModule: createDownloadTicketsModule(db, storage, sendLinksModule, filesModule),
    presignTtlSeconds: PRESIGN_TTL,
    intervalSeconds: 60,
    pendingGraceSeconds: GRACE,
    retentionSeconds: RETENTION,
    storage,
    multipartTtlSeconds: MULTIPART_TTL,
    logger: { info() {}, error() {} },
  });

  /** Stand-in for the signed PUT route: write the object and its sidecar. */
  async function putObject(key: string, size = 16): Promise<void> {
    const path = join(objectsDir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(size, 1));
    await writeFile(`${path}.meta.json`, JSON.stringify({ contentType: 'text/plain', size }));
  }

  function ticket(ticketId: string) {
    const row = db.select().from(uploadTickets).where(eq(uploadTickets.id, ticketId)).get();
    assert.ok(row, `ticket ${ticketId} exists`);
    return row;
  }

  /** Mint and PUT a 16-byte single-PUT receive upload; returns ticket id and key. */
  async function uploadReceive(linkCode: string) {
    const minted = await uploadTicketsModule.createForReceiveLink({
      linkCode,
      filename: 'a.txt',
      contentType: 'text/plain',
      sizeHint: 16,
    });
    assert.equal(minted.kind, 'ok');
    assert.ok(minted.kind === 'ok');
    const { s3Key } = ticket(minted.value.ticketId);
    await putObject(s3Key);
    return { ticketId: minted.value.ticketId, s3Key };
  }

  return {
    objectsDir,
    db,
    storage,
    receiveLinksModule,
    sendLinksModule,
    filesModule,
    uploadTicketsModule,
    sweeper,
    putObject,
    ticket,
    uploadReceive,
    cleanup: () => rmSync(objectsDir, { recursive: true, force: true }),
  };
}

/** Every regular file under `dir`, relative paths. Empty when `dir` is gone. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));
}

/** Poll for a background best-effort delete (link removal is fire-and-forget). */
async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await delay(10);
  assert.ok(check(), 'condition not reached within 1s');
}

test('sweep deletes the bytes of single-PUT tickets that were never finalized', async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const link = await env.receiveLinksModule.create({ label: 'Path 1', maxUploads: 1 });

  const uploads = [];
  for (let i = 0; i < 3; i++) uploads.push(await env.uploadReceive(link.code));
  // Unfinalized bytes don't count toward maxUploads, so minting continues.
  const fourth = await env.uploadTicketsModule.createForReceiveLink({
    linkCode: link.code,
    filename: 'a.txt',
    contentType: 'text/plain',
    sizeHint: 16,
  });
  assert.equal(fourth.kind, 'ok');

  const linkDir = join(env.objectsDir, 'receive', link.id);
  assert.equal(filesUnder(linkDir).length, 6); // 3 objects + 3 sidecars

  const createdAt = Math.max(...env.db.select().from(uploadTickets).all().map((r) => r.createdAt));
  const expireAt = createdAt + PRESIGN_TTL + GRACE + 1;
  const expired = await env.sweeper.runOnce(expireAt);
  assert.equal(expired.expiredUploadTickets, 4);
  const reclaimed = await env.sweeper.runOnce(expireAt + RETENTION + 1);
  // The 4th ticket never got bytes; deleting a missing object still counts.
  assert.equal(reclaimed.reclaimedObjects, 4);
  assert.equal(reclaimed.deletedUploadTickets, 4);

  assert.equal(env.db.select().from(uploadTickets).all().length, 0);
  assert.deepEqual(filesUnder(linkDir), []);
});

test('sweep keeps the object of a finalized ticket when its row ages out', async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const link = await env.receiveLinksModule.create({ label: 'Published' });
  const { ticketId, s3Key } = await env.uploadReceive(link.code);

  const finalized = await env.uploadTicketsModule.finalize(ticketId);
  assert.equal(finalized.kind, 'completed');
  assert.ok(finalized.kind === 'completed');
  const { completedAt } = env.ticket(ticketId);
  assert.ok(completedAt !== null);

  const counters = await env.sweeper.runOnce(completedAt + RETENTION + 1);
  assert.equal(counters.deletedUploadTickets, 1);
  assert.equal(counters.reclaimedObjects, 0);

  const file = await env.filesModule.getById(finalized.fileId);
  assert.equal(file?.s3Key, s3Key);
  assert.equal((await env.storage.headObject(s3Key))?.size, 16);
});

test('finalize refuses a multipart ticket and leaves it for the multipart TTL abort', async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const link = await env.receiveLinksModule.create({ label: 'Path 2' });

  const init = await env.uploadTicketsModule.initMultipart({
    linkCode: link.code,
    filename: 'big.bin',
    contentType: 'application/octet-stream',
    size: 2 * PART_SIZE,
  });
  assert.equal(init.kind, 'ok');
  assert.ok(init.kind === 'ok');
  const sessionDir = join(env.objectsDir, '.multipart', init.value.uploadId);
  for (const n of [1, 2]) await writeFile(join(sessionDir, `${n}.part`), Buffer.alloc(PART_SIZE));

  const outcome = await env.uploadTicketsModule.finalize(init.value.ticketId);
  assert.deepEqual(outcome, { kind: 'wrong_protocol' });
  const row = env.ticket(init.value.ticketId);
  assert.equal(row.status, 'pending');

  const counters = await env.sweeper.runOnce(row.createdAt + MULTIPART_TTL + 1);
  assert.equal(counters.abortedPendingMultipart, 1);
  assert.equal(existsSync(sessionDir), false);
});

test('deleting a receive link deletes unpublished single-PUT objects and keeps published ones', async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const link = await env.receiveLinksModule.create({ label: 'Delete me' });
  const pending = await env.uploadReceive(link.code);
  const published = await env.uploadReceive(link.code);
  assert.equal((await env.uploadTicketsModule.finalize(published.ticketId)).kind, 'completed');

  assert.equal(await env.receiveLinksModule.remove(link.id), true);

  const pendingPath = join(env.objectsDir, pending.s3Key);
  await waitUntil(() => !existsSync(pendingPath) && !existsSync(`${pendingPath}.meta.json`));
  assert.equal((await env.storage.headObject(published.s3Key))?.size, 16);
});

test('deleting a send link deletes unpublished single-PUT objects', async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const link = await env.sendLinksModule.create({ label: 'Send' });
  const minted = await env.uploadTicketsModule.createForSendLink({
    sendLinkId: link.id,
    filename: 'a.txt',
    contentType: 'text/plain',
    sizeHint: 16,
  });
  assert.ok(minted.kind === 'ok');
  const { s3Key } = env.ticket(minted.value.ticketId);
  await env.putObject(s3Key);

  assert.equal(await env.sendLinksModule.remove(link.id), true);

  await waitUntil(() => !existsSync(join(env.objectsDir, s3Key)));
});

test('receive mints are refused below the free-disk floor; admin send mints are not', async (t) => {
  // 1000 bytes free, floor 1000: any non-empty receive upload would cross it.
  const env = setup({
    dir: '/unused',
    minFreeBytes: 1000,
    statfs: async () => ({ bavail: 10, bsize: 100 }),
  });
  t.after(env.cleanup);
  const receive = await env.receiveLinksModule.create({ label: 'Full disk' });
  const insufficient = { kind: 'invalid_input', reason: 'insufficient_storage' };

  assert.deepEqual(
    await env.uploadTicketsModule.createForReceiveLink({
      linkCode: receive.code,
      filename: 'a.txt',
      contentType: 'text/plain',
      sizeHint: 16,
    }),
    insufficient,
  );
  assert.deepEqual(
    await env.uploadTicketsModule.initMultipart({
      linkCode: receive.code,
      filename: 'a.bin',
      contentType: 'application/octet-stream',
      size: 2 * PART_SIZE,
    }),
    insufficient,
  );

  const send = await env.sendLinksModule.create({ label: 'Admin' });
  const sendMint = await env.uploadTicketsModule.createForSendLink({
    sendLinkId: send.id,
    filename: 'a.txt',
    contentType: 'text/plain',
    sizeHint: 16,
  });
  assert.equal(sendMint.kind, 'ok');
});
