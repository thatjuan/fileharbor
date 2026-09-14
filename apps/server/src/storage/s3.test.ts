import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

import type { S3StorageConfig } from '../config.js';
import { createS3StorageProvider } from './s3.js';

const config: S3StorageConfig = {
  backend: 's3',
  endpoint: 'https://s3.example.test',
  region: 'auto',
  accessKeyId: 'test',
  secretAccessKey: 'test',
  bucket: 'bucket',
  forcePathStyle: true,
  presignTtlSeconds: 60,
  multipart: {
    thresholdBytes: 1024,
    partSizeBytes: 512,
    ttlSeconds: 60,
    maxObjectSizeBytes: 1024 * 1024,
  },
};

function clientWithSend(
  send: (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>,
): S3Client {
  return { send } as unknown as S3Client;
}

test('S3 openRead returns the SDK Node stream without buffering it', async () => {
  const body = Readable.from('hello');
  const storage = createS3StorageProvider(
    config,
    clientWithSend(async (command) => {
      assert.equal(command instanceof GetObjectCommand, true);
      return { Body: body, ContentLength: 5, $metadata: {} };
    }),
  );
  const opened = await storage.openRead('object');
  assert.ok(opened);
  assert.equal(opened.body, body);
  assert.equal(opened.size, 5);
});

test('S3 openRead maps only not-found responses and propagates other failures', async () => {
  const missing = createS3StorageProvider(
    config,
    clientWithSend(async () => {
      throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
    }),
  );
  assert.equal(await missing.openRead('missing'), null);

  const failed = createS3StorageProvider(
    config,
    clientWithSend(async () => {
      throw Object.assign(new Error('forbidden'), { $metadata: { httpStatusCode: 403 } });
    }),
  );
  await assert.rejects(failed.openRead('forbidden'), /forbidden/);
});

test('S3 openRead passes abort through to the SDK request', async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const storage = createS3StorageProvider(
    config,
    clientWithSend((_command, options) => {
      receivedSignal = options?.abortSignal;
      return new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }),
  );
  const opening = storage.openRead('object', { signal: controller.signal });
  controller.abort();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(receivedSignal, controller.signal);
});

test('errors emitted by an opened S3 body propagate through the returned stream', async () => {
  const body = new Readable({
    read() {
      this.destroy(new Error('midstream_failure'));
    },
  });
  const storage = createS3StorageProvider(
    config,
    clientWithSend(async () => ({ Body: body, ContentLength: 4, $metadata: {} })),
  );
  const opened = await storage.openRead('object');
  assert.ok(opened);
  await assert.rejects(async () => {
    for await (const _chunk of opened.body) {
      // Consume until the provider stream fails.
    }
  }, /midstream_failure/);
});
