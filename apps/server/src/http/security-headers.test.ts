import test from 'node:test';
import assert from 'node:assert/strict';

import type { AppConfig } from '../config.js';
import { buildContentSecurityPolicy, deriveStorageConnectSources } from './security-headers.js';

function baseConfig(storage: AppConfig['storage']): AppConfig {
  return {
    port: 3000,
    nodeEnv: 'production',
    dataDir: '/tmp/fileharbor-test',
    databasePath: '/tmp/fileharbor-test/db.sqlite',
    webDistDir: '/tmp/fileharbor-test/web',
    auth: {
      secret: 'secret',
      baseUrl: 'https://files.example.com',
      adminSeed: null,
    },
    storage,
    ticketSweep: {
      intervalSeconds: 60,
      pendingGraceSeconds: 60,
      retentionSeconds: 604800,
    },
    security: {
      trustProxyHeaders: false,
      rateLimit: {
        enabled: true,
        maxTrackedKeys: 100,
        auth: { max: 1, windowSeconds: 1 },
        setup: { max: 1, windowSeconds: 1 },
        publicLink: { max: 1, windowSeconds: 1 },
        publicTicket: { max: 1, windowSeconds: 1 },
        publicPartUrls: { max: 1, windowSeconds: 1 },
        publicConfirm: { max: 1, windowSeconds: 1 },
      },
      headers: {
        enabled: true,
        hstsEnabled: true,
        hstsMaxAgeSeconds: 15552000,
        hstsIncludeSubDomains: false,
        hstsPreload: false,
        cspExtraConnectSrc: ['https://extra.example.com'],
      },
    },
    tunnel: { enabled: false, domain: null },
  };
}

test('local storage CSP uses self for connect-src', () => {
  const config = baseConfig({
    backend: 'local',
    objectsDir: '/tmp/objects',
    signingSecret: 'secret',
    presignTtlSeconds: 300,
    multipart: {
      thresholdBytes: 1,
      partSizeBytes: 5 * 1024 * 1024,
      ttlSeconds: 7200,
      maxObjectSizeBytes: 10 * 1024 * 1024,
    },
  });

  const csp = buildContentSecurityPolicy(config);
  assert.match(csp, /connect-src 'self' https:\/\/extra\.example\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('virtual-hosted S3 CSP includes endpoint, bucket host, and wildcard host', () => {
  const storage = {
    backend: 's3' as const,
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    region: 'us-east-1',
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    bucket: 'fileharbor',
    forcePathStyle: false,
    presignTtlSeconds: 300,
    multipart: {
      thresholdBytes: 1,
      partSizeBytes: 5 * 1024 * 1024,
      ttlSeconds: 7200,
      maxObjectSizeBytes: 10 * 1024 * 1024,
    },
  };

  assert.deepEqual(deriveStorageConnectSources(storage), [
    'https://s3.us-east-1.amazonaws.com',
    'https://fileharbor.s3.us-east-1.amazonaws.com',
    'https://*.s3.us-east-1.amazonaws.com',
  ]);
});
