import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp, type AppModules } from '../app.js';
import type { AuthModule } from '../auth/index.js';
import type { AppConfig, LocalStorageConfig } from '../config.js';
import type { DownloadTicketsModule } from '../tickets/download-tickets.js';
import type { FilesModule } from '../files/files.js';
import type { ReceiveLinksModule } from '../links/receive-links.js';
import type { SendLinksModule } from '../links/send-links.js';
import type { NotificationsModule } from '../notifications/notifications.js';
import { createLocalStorageProvider } from '../storage/local.js';
import type { UploadTicketsModule } from '../tickets/upload-tickets.js';

const KiB = 1024;
const MiB = 1024 * KiB;
const ORIGIN = 'http://localhost:3000';

function localStorageConfig(objectsDir: string): LocalStorageConfig {
  return {
    backend: 'local',
    objectsDir,
    signingSecret: 'test-signing-secret',
    presignTtlSeconds: 300,
    minFreeBytes: 0,
    multipart: {
      thresholdBytes: 100 * MiB,
      partSizeBytes: 16 * MiB,
      ttlSeconds: 7200,
      maxObjectSizeBytes: 1024 * MiB,
    },
  };
}

/** App config on the local storage backend, with rate limits loose enough to stay out of the way. */
function appConfig(storage: LocalStorageConfig): AppConfig {
  const window = { max: 1_000, windowSeconds: 60 };
  return {
    port: 3000,
    bindHost: '127.0.0.1',
    nodeEnv: 'test',
    dataDir: storage.objectsDir,
    databasePath: ':memory:',
    webDistDir: storage.objectsDir,
    auth: {
      baseUrl: ORIGIN,
      secret: 'test-secret-value-that-is-long-enough-1234',
      adminSeed: null,
    },
    storage,
    ticketSweep: { intervalSeconds: 60, pendingGraceSeconds: 60, retentionSeconds: 60 },
    security: {
      clientIpSource: { kind: 'socket' },
      trustProxyHeaders: false,
      rateLimit: {
        enabled: true,
        maxTrackedKeys: 100,
        auth: window,
        setup: window,
        publicLink: window,
        publicUpload: window,
        publicTicket: window,
        publicPartUrls: window,
        publicConfirm: window,
      },
      headers: {
        enabled: false,
        hstsEnabled: false,
        hstsMaxAgeSeconds: 0,
        hstsIncludeSubDomains: false,
        hstsPreload: false,
        cspExtraConnectSrc: [],
      },
    },
    tunnel: { enabled: false, domain: null },
  };
}

/** Calls each fake module records, so tests can assert a handler never ran. */
interface Calls {
  finalize: number;
  complete: number;
  createFirstAdmin: number;
}

/**
 * Build the real app over a temp objects dir, with fake modules that count the
 * calls a handler makes. `cleanup` removes the temp dir.
 */
async function fixture(): Promise<{
  app: ReturnType<typeof createApp>;
  storageConfig: LocalStorageConfig;
  calls: Calls;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'fileharbor-body-limit-'));
  const storageConfig = localStorageConfig(dir);
  const calls: Calls = { finalize: 0, complete: 0, createFirstAdmin: 0 };

  const uploadTicketsModule = {
    async finalize() {
      calls.finalize += 1;
      return { kind: 'completed', fileId: randomUUID() };
    },
    async completeMultipart() {
      calls.complete += 1;
      return { kind: 'completed', fileId: randomUUID() };
    },
  } as unknown as UploadTicketsModule;
  const authModule = {
    auth: { handler: async () => new Response(null, { status: 404 }) },
    hasAnyUser: () => false,
    getSession: async () => null,
    createFirstAdmin: async () => {
      calls.createFirstAdmin += 1;
    },
  } as unknown as AuthModule;

  const modules: AppModules = {
    authModule,
    receiveLinksModule: {} as ReceiveLinksModule,
    sendLinksModule: {} as SendLinksModule,
    uploadTicketsModule,
    downloadTicketsModule: {} as DownloadTicketsModule,
    filesModule: {} as FilesModule,
    notificationsModule: {} as NotificationsModule,
    storage: createLocalStorageProvider(storageConfig),
  };

  return {
    app: createApp(appConfig(storageConfig), modules),
    storageConfig,
    calls,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** A JSON body of exactly `bytes` bytes: `{"password":"xxx…"}`. */
function paddedJson(bytes: number): string {
  const overhead = JSON.stringify({ password: '' }).length;
  return JSON.stringify({ password: 'x'.repeat(bytes - overhead) });
}

/** A multipart-complete body padded with `{partNumber, etag}` entries to about `bytes`. */
function partsJson(bytes: number): string {
  const etag = `"${'a'.repeat(32)}"`;
  const parts: { partNumber: number; etag: string }[] = [];
  let size = JSON.stringify({ parts: [] }).length;
  while (size < bytes) {
    const entry = { partNumber: parts.length + 1, etag };
    parts.push(entry);
    size += JSON.stringify(entry).length + 1;
  }
  return JSON.stringify({ parts });
}

function postJson(body: string) {
  return {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  };
}

async function assertTooLarge(res: Response): Promise<void> {
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'payload_too_large' });
}

test('public finalize rejects a 65 KiB body before the handler runs', async () => {
  const { app, calls, cleanup } = await fixture();
  try {
    const path = `/api/public/upload-tickets/${randomUUID()}/finalize`;
    await assertTooLarge(await app.request(path, postJson(paddedJson(65 * KiB))));
    assert.equal(calls.finalize, 0);
  } finally {
    await cleanup();
  }
});

test('public multipart complete admits 900 KB and rejects 1.1 MiB', async () => {
  const { app, calls, cleanup } = await fixture();
  try {
    const path = `/api/public/upload-tickets/${randomUUID()}/upload/multipart/complete`;

    const accepted = await app.request(path, postJson(partsJson(900_000)));
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { status: 'completed' });
    assert.equal(calls.complete, 1);

    await assertTooLarge(await app.request(path, postJson(partsJson(1.1 * MiB))));
    assert.equal(calls.complete, 1);
  } finally {
    await cleanup();
  }
});

test('admin multipart complete shares the 1 MiB cap', async () => {
  const { app, cleanup } = await fixture();
  try {
    const path = `/api/send-links/${randomUUID()}/files/multipart/${randomUUID()}/complete`;
    await assertTooLarge(await app.request(path, postJson(partsJson(1.1 * MiB))));
  } finally {
    await cleanup();
  }
});

test('setup rejects a 17 KiB body', async () => {
  const { app, calls, cleanup } = await fixture();
  try {
    await assertTooLarge(await app.request('/api/setup', postJson(paddedJson(17 * KiB))));
    assert.equal(calls.createFirstAdmin, 0);
  } finally {
    await cleanup();
  }
});

test('a chunked body with no Content-Length is cut off once it streams past the cap', async () => {
  const { app, calls, cleanup } = await fixture();
  try {
    const chunk = new Uint8Array(16 * KiB).fill(0x20);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 5 × 16 KiB = 80 KiB, past the 64 KiB public cap.
        if (sent === 5) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const request = new Request(
      `http://localhost/api/public/upload-tickets/${randomUUID()}/finalize`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' },
    );
    assert.equal(request.headers.has('content-length'), false);

    await assertTooLarge(await app.request(request));
    assert.equal(calls.finalize, 0);
  } finally {
    await cleanup();
  }
});

test('local storage PUT is not body-limited', async () => {
  const { app, storageConfig, cleanup } = await fixture();
  try {
    const bytes = new Uint8Array(2 * MiB).fill(0x61);
    const signed = await createLocalStorageProvider(storageConfig).presignPut('uploads/big.bin', {
      contentLength: bytes.byteLength,
    });

    const res = await app.request(signed.url, {
      method: 'PUT',
      headers: { 'content-length': String(bytes.byteLength) },
      body: bytes,
    });
    assert.equal(res.status, 200);
    const stored = await readFile(join(storageConfig.objectsDir, 'uploads/big.bin'));
    assert.equal(stored.byteLength, bytes.byteLength);
  } finally {
    await cleanup();
  }
});
