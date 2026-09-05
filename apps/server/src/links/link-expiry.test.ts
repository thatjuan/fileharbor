import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';
import { openDatabase } from '../db/client.js';
import type { Db } from '../db/client.js';
import type { FilesModule } from '../files/files.js';
import { createReceiveLinksModule } from './receive-links.js';
import { createSendLinksModule } from './send-links.js';
import { createReceiveLinksRoute } from '../routes/receive-links.js';
import { createSendLinksRoute } from '../routes/send-links.js';
import type { StorageProvider } from '../storage/index.js';
import type { UploadTicketsModule } from '../tickets/upload-tickets.js';

/**
 * `PATCH /api/{send,receive}-links/:id` gained `expiresAt` for the dashboard's
 * bulk expiry change (#68). Expiry was previously settable only at creation,
 * so these cases pin the new whitelist entry on both link kinds: an epoch
 * integer sets it, `null` clears it, a non-number is a 400, and a PATCH that
 * carries only `expiresAt` must not disturb the link's `status`.
 */

function memoryDb(): Db {
  return openDatabase(':memory:', new URL('../../drizzle', import.meta.url).pathname);
}

// The modules only reach for storage when deleting a link (multipart aborts).
const noStorage = {} as StorageProvider;

// Auth is not what's under test; the routes only need `getSession` to pass.
const authModule = {
  getSession: async () => ({
    user: { id: 'u1', name: 'admin', email: 'admin@local', username: 'admin' },
  }),
} as unknown as AuthModule;

const noFiles = {
  listForReceiveLink: async () => [],
  listForSendLink: async () => [],
} as unknown as FilesModule;

function receiveApp(db: Db): Hono {
  const module = createReceiveLinksModule(db, noStorage);
  return new Hono().route('/receive-links', createReceiveLinksRoute(authModule, module, noFiles));
}

function sendApp(db: Db): Hono {
  const module = createSendLinksModule(db, noStorage);
  return new Hono().route(
    '/send-links',
    createSendLinksRoute(authModule, module, {} as UploadTicketsModule, noFiles),
  );
}

async function patch(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createLink(app: Hono, path: string, label: string): Promise<string> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  assert.equal(res.status, 200);
  const { link } = (await res.json()) as { link: { id: string } };
  return link.id;
}

test('receive-link PATCH sets, clears, and validates expiresAt', async () => {
  const app = receiveApp(memoryDb());
  const id = await createLink(app, '/receive-links', 'inbox');

  const set = await patch(app, `/receive-links/${id}`, { expiresAt: 1893456000 });
  assert.equal(set.status, 200);
  const setBody = (await set.json()) as { link: { expiresAt: number | null; status: string } };
  assert.equal(setBody.link.expiresAt, 1893456000);
  // An expiry-only PATCH must leave the lifecycle flag alone.
  assert.equal(setBody.link.status, 'active');

  const cleared = await patch(app, `/receive-links/${id}`, { expiresAt: null });
  assert.equal(cleared.status, 200);
  const clearedBody = (await cleared.json()) as { link: { expiresAt: number | null } };
  assert.equal(clearedBody.link.expiresAt, null);

  const bad = await patch(app, `/receive-links/${id}`, { expiresAt: 'tomorrow' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), {
    error: 'invalid_input',
    message: 'invalid_expires_at',
  });
});

test('send-link PATCH sets, clears, and validates expiresAt', async () => {
  const app = sendApp(memoryDb());
  const id = await createLink(app, '/send-links', 'bundle');

  const set = await patch(app, `/send-links/${id}`, { expiresAt: 1893456000 });
  assert.equal(set.status, 200);
  const setBody = (await set.json()) as { link: { expiresAt: number | null; status: string } };
  assert.equal(setBody.link.expiresAt, 1893456000);
  assert.equal(setBody.link.status, 'active');

  const cleared = await patch(app, `/send-links/${id}`, { expiresAt: null });
  assert.equal(cleared.status, 200);
  const clearedBody = (await cleared.json()) as { link: { expiresAt: number | null } };
  assert.equal(clearedBody.link.expiresAt, null);

  const bad = await patch(app, `/send-links/${id}`, { expiresAt: false });
  assert.equal(bad.status, 400);
});

test('link PATCH still rejects a body with nothing updatable', async () => {
  const app = receiveApp(memoryDb());
  const id = await createLink(app, '/receive-links', 'inbox');

  const empty = await patch(app, `/receive-links/${id}`, {});
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), {
    error: 'invalid_input',
    message: 'no_updatable_fields',
  });

  const bogusStatus = await patch(app, `/receive-links/${id}`, { status: 'archived' });
  assert.equal(bogusStatus.status, 400);
});
