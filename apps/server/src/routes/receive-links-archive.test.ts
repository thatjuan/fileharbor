import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';
import type { FileRecord, FilesModule } from '../files/files.js';
import type { ReceiveLink, ReceiveLinksModule } from '../links/receive-links.js';
import type { StorageProvider } from '../storage/index.js';
import { createReceiveLinksRoute } from './receive-links.js';

const link: ReceiveLink = {
  id: 'link-1',
  code: 'SAFE123',
  label: 'Inbox',
  passwordHash: null,
  maxUploads: null,
  expiresAt: null,
  status: 'active',
  createdAt: 1,
};

const linkedFile: FileRecord = {
  id: 'file-1',
  s3Key: 'objects/file-1',
  filename: 'hello.txt',
  contentType: 'text/plain',
  size: 5,
  createdAt: 1,
  receiveLinkId: link.id,
  sendLinkId: null,
};

function routeFixture(
  options: {
    authenticated?: boolean;
    foundLink?: ReceiveLink | null;
    files?: FileRecord[];
    openRead?: StorageProvider['openRead'];
  } = {},
): { app: Hono; calls: { links: number; files: number; storage: number } } {
  const calls = { links: 0, files: 0, storage: 0 };
  const auth = {
    getSession: async () =>
      options.authenticated === false
        ? null
        : { user: { id: 'admin', name: 'Admin', email: 'admin@local', username: 'admin' } },
  } as unknown as AuthModule;
  const receiveLinks = {
    async getById() {
      calls.links += 1;
      return options.foundLink === undefined ? link : options.foundLink;
    },
  } as unknown as ReceiveLinksModule;
  const files = {
    async listForReceiveLink() {
      calls.files += 1;
      return options.files ?? [linkedFile];
    },
  } as unknown as FilesModule;
  const storage = {
    bucket: 'test',
    defaultTtlSeconds: 60,
    async openRead(key: string, readOptions?: { signal?: AbortSignal }) {
      calls.storage += 1;
      if (options.openRead) return options.openRead(key, readOptions);
      return { body: Readable.from('hello'), size: 5 };
    },
  } as unknown as StorageProvider;
  const app = new Hono().route(
    '/receive-links',
    createReceiveLinksRoute(auth, receiveLinks, files, storage),
  );
  return { app, calls };
}

test('archive authentication precedes link, file, and storage reads', async () => {
  const { app, calls } = routeFixture({ authenticated: false });
  const response = await app.request('/receive-links/link-1/download');
  assert.equal(response.status, 401);
  assert.deepEqual(calls, { links: 0, files: 0, storage: 0 });
});

test('archive maps missing link, empty link, and initial storage failures before ZIP headers', async () => {
  const missingLink = routeFixture({ foundLink: null });
  assert.equal((await missingLink.app.request('/receive-links/missing/download')).status, 404);
  assert.equal(missingLink.calls.storage, 0);

  const empty = routeFixture({ files: [] });
  assert.equal((await empty.app.request('/receive-links/link-1/download')).status, 409);
  assert.equal(empty.calls.storage, 0);

  const missingFile = routeFixture({ openRead: async () => null });
  const missingResponse = await missingFile.app.request('/receive-links/link-1/download');
  assert.equal(missingResponse.status, 409);
  assert.deepEqual(await missingResponse.json(), { error: 'file_missing' });
  assert.equal(missingResponse.headers.get('content-type')?.startsWith('application/json'), true);

  const changed = routeFixture({
    openRead: async () => ({ body: Readable.from('sixsix'), size: 6 }),
  });
  assert.deepEqual(await (await changed.app.request('/receive-links/link-1/download')).json(), {
    error: 'file_changed',
  });

  const unavailable = routeFixture({
    openRead: async () => {
      throw new Error('network_down');
    },
  });
  const unavailableResponse = await unavailable.app.request('/receive-links/link-1/download');
  assert.equal(unavailableResponse.status, 503);
  assert.deepEqual(await unavailableResponse.json(), { error: 'storage_unavailable' });

  const invalid = routeFixture({
    openRead: async () => {
      throw new Error('invalid_storage_key');
    },
  });
  const invalidResponse = await invalid.app.request('/receive-links/link-1/download');
  assert.equal(invalidResponse.status, 500);
  assert.deepEqual(await invalidResponse.json(), { error: 'internal_error' });
});

test('archive response has download headers, ignores Range, excludes foreign rows, and HEAD opens nothing', async () => {
  const foreign = { ...linkedFile, id: 'foreign', s3Key: 'foreign', receiveLinkId: 'other' };
  const { app, calls } = routeFixture({ files: [foreign, linkedFile] });

  const head = await app.request('/receive-links/link-1/download', { method: 'HEAD' });
  assert.equal(head.status, 405);
  assert.equal(calls.storage, 0);

  const response = await app.request('/receive-links/link-1/download', {
    headers: { Range: 'bytes=10-' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(
    response.headers.get('content-disposition'),
    'attachment; filename="receive-SAFE123.zip"',
  );
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.has('content-length'), false);
  assert.equal(response.headers.has('accept-ranges'), false);
  assert.equal(calls.storage, 1);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.notEqual(bytes.indexOf(Buffer.from('hello.txt')), -1);
  assert.equal(bytes.indexOf(Buffer.from('foreign')), -1);
});

test('disabled and expired receive links remain downloadable by an admin', async () => {
  for (const restricted of [
    { ...link, status: 'disabled' as const },
    { ...link, expiresAt: 1 },
  ]) {
    const { app } = routeFixture({ foundLink: restricted });
    const response = await app.request('/receive-links/link-1/download');
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
});

test('a real HTTP client disconnect closes the active storage source', async () => {
  const source = new PassThrough();
  let opens = 0;
  const second = { ...linkedFile, id: 'file-2', s3Key: 'objects/file-2', createdAt: 2 };
  const { app } = routeFixture({
    files: [linkedFile, second],
    openRead: async () => {
      opens += 1;
      return { body: source, size: 5 };
    },
  });
  const { server, port } = await new Promise<{
    server: ReturnType<typeof serve>;
    port: number;
  }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({ server, port: info.port });
    });
  });

  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/receive-links/link-1/download`, {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    await reader.read();
    controller.abort();
    await delay(20);
    assert.equal(source.destroyed, true);
    assert.equal(opens, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
