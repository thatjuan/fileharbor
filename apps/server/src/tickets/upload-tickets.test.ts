import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';

import { openDatabase } from '../db/client.js';
import { files, sendLinks, uploadTickets } from '../db/schema.js';
import { createFilesModule } from '../files/files.js';
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
