import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createLocalStorageProvider } from './local.js';

async function fixture(): Promise<{
  dir: string;
  storage: ReturnType<typeof createLocalStorageProvider>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'fileharbor-open-read-'));
  return {
    dir,
    storage: createLocalStorageProvider({
      backend: 'local',
      objectsDir: dir,
      signingSecret: 'test-secret',
      presignTtlSeconds: 60,
      multipart: {
        thresholdBytes: 1024,
        partSizeBytes: 512,
        ttlSeconds: 60,
        maxObjectSizeBytes: 1024 * 1024,
      },
    }),
  };
}

test('local openRead opens regular files before resolving and reports missing files', async () => {
  const { dir, storage } = await fixture();
  try {
    await writeFile(join(dir, 'object'), 'hello');
    const opened = await storage.openRead('object');
    assert.ok(opened);
    assert.equal(opened.size, 5);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'hello');
    assert.equal(await storage.openRead('missing'), null);
    await assert.rejects(storage.openRead('../outside'), /invalid_storage_key/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('local openRead abort closes the active file stream', async () => {
  const { dir, storage } = await fixture();
  try {
    await writeFile(join(dir, 'large'), Buffer.alloc(1024 * 1024));
    const controller = new AbortController();
    const opened = await storage.openRead('large', { signal: controller.signal });
    assert.ok(opened);
    opened.body.resume();
    controller.abort();
    await delay(0);
    assert.equal(opened.body.destroyed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
