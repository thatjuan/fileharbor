import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';

import { openDatabase } from '../db/client.js';
import { files, receiveLinks, sendLinks, uploadTickets } from '../db/schema.js';
import { createFilesModule } from '../files/files.js';
import { createReceiveLinksModule } from '../links/receive-links.js';
import { createSendLinksModule } from '../links/send-links.js';
import type { StorageProvider } from '../storage/index.js';
import { createUploadTicketsModule } from './upload-tickets.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../drizzle');

test('multipart completion rejects S3 object size mismatch before publishing file row', async () => {
  const dbPath = `/tmp/fileharbor-upload-ticket-${Date.now()}-${randomUUID()}.db`;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath, migrationsFolder);

  let deleteObjectCalls = 0;
  const storage: StorageProvider = {
    bucket: 'fake-s3',
    defaultTtlSeconds: 300,
    async presignPut() {
      return { url: 'https://storage.example/put', expiresAt: new Date() };
    },
    async presignGet() {
      return { url: 'https://storage.example/get', expiresAt: new Date() };
    },
    async presignDelete() {
      return { url: 'https://storage.example/delete', expiresAt: new Date() };
    },
    async headObject() {
      return {
        size: 11,
        contentType: 'text/plain',
        etag: '"etag"',
        lastModified: new Date(),
      };
    },
    async deleteObject() {
      deleteObjectCalls += 1;
    },
    async initMultipart() {
      return { uploadId: 'upload-1', partSize: 5, expectedParts: 2 };
    },
    async presignUploadPart() {
      return { url: 'https://storage.example/part', expiresAt: new Date() };
    },
    async completeMultipart() {
      return { etag: '"complete"' };
    },
    async abortMultipart() {},
  };

  const sendLinksModule = createSendLinksModule(db, storage);
  const filesModule = createFilesModule(db);
  const uploadTicketsModule = createUploadTicketsModule(
    db,
    storage,
    {
      async create() {
        throw new Error('unused');
      },
      async list() {
        return [];
      },
      async getById() {
        return null;
      },
      async getByCode() {
        return null;
      },
      async update() {
        return null;
      },
      async remove() {
        return false;
      },
      async recordUploadCount() {
        return 0;
      },
    },
    sendLinksModule,
    filesModule,
    {
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
    },
    {
      thresholdBytes: 1,
      partSizeBytes: 5,
      ttlSeconds: 7200,
      maxObjectSizeBytes: 20,
    },
  );

  const now = Math.floor(Date.now() / 1000);
  const sendLinkId = randomUUID();
  db.insert(sendLinks)
    .values({
      id: sendLinkId,
      code: 'sendtest',
      label: 'Send test',
      passwordHash: null,
      maxDownloads: null,
      downloadCount: 0,
      expiresAt: null,
      status: 'active',
      createdAt: now,
    })
    .run();

  const ticketId = randomUUID();
  db.insert(uploadTickets)
    .values({
      id: ticketId,
      intent: 'send',
      receiveLinkId: null,
      sendLinkId,
      s3Key: `send/${sendLinkId}/${ticketId}/x.txt`,
      filename: 'x.txt',
      contentType: 'text/plain',
      sizeHint: 10,
      status: 'pending',
      protocol: 'multipart',
      uploadId: 'upload-1',
      partSize: 5,
      expectedParts: 2,
      createdAt: now,
      completedAt: null,
    })
    .run();

  const outcome = await uploadTicketsModule.completeMultipart(ticketId, {
    parts: [
      { partNumber: 1, etag: '"one"' },
      { partNumber: 2, etag: '"two"' },
    ],
  });

  assert.deepEqual(outcome, { kind: 'failed', reason: 'storage_complete_failed' });
  assert.equal(deleteObjectCalls, 1);
  assert.equal(
    db.select().from(uploadTickets).where(eq(uploadTickets.id, ticketId)).get()?.status,
    'failed',
  );
  assert.equal(db.select().from(files).all().length, 0);

  rmSync(dbPath, { force: true });
});

function fakeNotificationsModule() {
  return {
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
}

const multipartConfig = {
  thresholdBytes: 1,
  partSizeBytes: 5,
  ttlSeconds: 7200,
  maxObjectSizeBytes: 20,
};

function insertReceiveLink(db: ReturnType<typeof openDatabase>, maxUploads: number): string {
  const linkId = randomUUID();
  db.insert(receiveLinks)
    .values({
      id: linkId,
      code: `recv-${linkId.slice(0, 8)}`,
      label: 'Quota test',
      passwordHash: null,
      maxUploads,
      expiresAt: null,
      status: 'active',
      createdAt: Math.floor(Date.now() / 1000),
    })
    .run();
  return linkId;
}

test('concurrent single-PUT finalizes cannot exceed receive-link max_uploads', async () => {
  const dbPath = `/tmp/fileharbor-upload-ticket-${Date.now()}-${randomUUID()}.db`;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath, migrationsFolder);

  // Latch on headObject: both finalizes pass the advisory policy check
  // (count = 0 < max = 1) and park here; releasing the latch lets them race
  // into the publish transaction.
  let headCalls = 0;
  let releaseHead = () => {};
  const headGate = new Promise<void>((resolveGate) => {
    releaseHead = resolveGate;
  });
  let deleteObjectCalls = 0;
  const storage: StorageProvider = {
    bucket: 'fake-s3',
    defaultTtlSeconds: 300,
    async presignPut() {
      return { url: 'https://storage.example/put', expiresAt: new Date() };
    },
    async presignGet() {
      return { url: 'https://storage.example/get', expiresAt: new Date() };
    },
    async presignDelete() {
      return { url: 'https://storage.example/delete', expiresAt: new Date() };
    },
    async headObject() {
      headCalls += 1;
      await headGate;
      return {
        size: 10,
        contentType: 'text/plain',
        etag: '"etag"',
        lastModified: new Date(),
      };
    },
    async deleteObject() {
      deleteObjectCalls += 1;
    },
    async initMultipart() {
      return { uploadId: 'upload-1', partSize: 5, expectedParts: 2 };
    },
    async presignUploadPart() {
      return { url: 'https://storage.example/part', expiresAt: new Date() };
    },
    async completeMultipart() {
      return { etag: '"complete"' };
    },
    async abortMultipart() {},
  };

  const receiveLinksModule = createReceiveLinksModule(db, storage);
  const sendLinksModule = createSendLinksModule(db, storage);
  const filesModule = createFilesModule(db);
  const uploadTicketsModule = createUploadTicketsModule(
    db,
    storage,
    receiveLinksModule,
    sendLinksModule,
    filesModule,
    fakeNotificationsModule(),
    multipartConfig,
  );

  const linkId = insertReceiveLink(db, 1);
  const now = Math.floor(Date.now() / 1000);
  const ticketIds = [randomUUID(), randomUUID()];
  for (const ticketId of ticketIds) {
    db.insert(uploadTickets)
      .values({
        id: ticketId,
        intent: 'receive',
        receiveLinkId: linkId,
        sendLinkId: null,
        s3Key: `receive/${linkId}/${ticketId}/x.txt`,
        filename: 'x.txt',
        contentType: 'text/plain',
        sizeHint: 10,
        status: 'pending',
        protocol: 'single',
        createdAt: now,
        completedAt: null,
      })
      .run();
  }

  const pending = ticketIds.map((id) => uploadTicketsModule.finalize(id));
  while (headCalls < 2) {
    await delay(5);
  }
  releaseHead();
  const outcomes = await Promise.all(pending);

  assert.deepEqual(outcomes.map((o) => o.kind).sort(), ['completed', 'policy_rejected']);
  const rejected = outcomes.find((o) => o.kind === 'policy_rejected');
  assert.ok(rejected && rejected.kind === 'policy_rejected');
  assert.deepEqual(rejected.policy, { kind: 'quota_exhausted' });

  // Exactly one file row published; the loser's staged object was deleted.
  assert.equal(db.select().from(files).where(eq(files.receiveLinkId, linkId)).all().length, 1);
  assert.equal(deleteObjectCalls, 1);
  const statuses = ticketIds
    .map((id) => db.select().from(uploadTickets).where(eq(uploadTickets.id, id)).get()?.status)
    .sort();
  assert.deepEqual(statuses, ['completed', 'failed']);

  rmSync(dbPath, { force: true });
});

test('concurrent multipart completes cannot exceed receive-link max_uploads', async () => {
  const dbPath = `/tmp/fileharbor-upload-ticket-${Date.now()}-${randomUUID()}.db`;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath, migrationsFolder);

  // Latch on storage.completeMultipart: both calls pass the advisory policy
  // re-check and their own pending → completing CAS (separate rows), then
  // park here before the publish transaction.
  let completeCalls = 0;
  let releaseComplete = () => {};
  const completeGate = new Promise<void>((resolveGate) => {
    releaseComplete = resolveGate;
  });
  let deleteObjectCalls = 0;
  const storage: StorageProvider = {
    bucket: 'fake-s3',
    defaultTtlSeconds: 300,
    async presignPut() {
      return { url: 'https://storage.example/put', expiresAt: new Date() };
    },
    async presignGet() {
      return { url: 'https://storage.example/get', expiresAt: new Date() };
    },
    async presignDelete() {
      return { url: 'https://storage.example/delete', expiresAt: new Date() };
    },
    async headObject() {
      return {
        size: 10,
        contentType: 'text/plain',
        etag: '"etag"',
        lastModified: new Date(),
      };
    },
    async deleteObject() {
      deleteObjectCalls += 1;
    },
    async initMultipart() {
      return { uploadId: 'upload-1', partSize: 5, expectedParts: 2 };
    },
    async presignUploadPart() {
      return { url: 'https://storage.example/part', expiresAt: new Date() };
    },
    async completeMultipart() {
      completeCalls += 1;
      await completeGate;
      return { etag: '"complete"' };
    },
    async abortMultipart() {},
  };

  const receiveLinksModule = createReceiveLinksModule(db, storage);
  const sendLinksModule = createSendLinksModule(db, storage);
  const filesModule = createFilesModule(db);
  const uploadTicketsModule = createUploadTicketsModule(
    db,
    storage,
    receiveLinksModule,
    sendLinksModule,
    filesModule,
    fakeNotificationsModule(),
    multipartConfig,
  );

  const linkId = insertReceiveLink(db, 1);
  const now = Math.floor(Date.now() / 1000);
  const ticketIds = [randomUUID(), randomUUID()];
  for (const [i, ticketId] of ticketIds.entries()) {
    db.insert(uploadTickets)
      .values({
        id: ticketId,
        intent: 'receive',
        receiveLinkId: linkId,
        sendLinkId: null,
        s3Key: `receive/${linkId}/${ticketId}/x.txt`,
        filename: 'x.txt',
        contentType: 'text/plain',
        sizeHint: 10,
        status: 'pending',
        protocol: 'multipart',
        uploadId: `upload-${i}`,
        partSize: 5,
        expectedParts: 2,
        createdAt: now,
        completedAt: null,
      })
      .run();
  }

  const parts = [
    { partNumber: 1, etag: '"one"' },
    { partNumber: 2, etag: '"two"' },
  ];
  const pending = ticketIds.map((id) => uploadTicketsModule.completeMultipart(id, { parts }));
  while (completeCalls < 2) {
    await delay(5);
  }
  releaseComplete();
  const outcomes = await Promise.all(pending);

  assert.deepEqual(outcomes.map((o) => o.kind).sort(), ['completed', 'policy_rejected']);
  const rejected = outcomes.find((o) => o.kind === 'policy_rejected');
  assert.ok(rejected && rejected.kind === 'policy_rejected');
  assert.deepEqual(rejected.policy, { kind: 'quota_exhausted' });

  assert.equal(db.select().from(files).where(eq(files.receiveLinkId, linkId)).all().length, 1);
  assert.equal(deleteObjectCalls, 1);
  const statuses = ticketIds
    .map((id) => db.select().from(uploadTickets).where(eq(uploadTickets.id, id)).get()?.status)
    .sort();
  assert.deepEqual(statuses, ['completed', 'failed']);

  rmSync(dbPath, { force: true });
});
