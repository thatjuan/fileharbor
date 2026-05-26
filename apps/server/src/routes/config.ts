import { Hono } from 'hono';

import type { StorageConfig } from '../config.js';

/**
 * Public, unauthenticated config endpoint. Exposes the multipart upload knobs
 * so the frontend can dispatch single-PUT vs multipart without rebuilding to
 * change the threshold. No secrets here — these values are operationally
 * sensitive only insofar as they let a recipient know the upload-size limits,
 * which the recipient learns immediately by attempting a too-large upload
 * anyway.
 */
export function createConfigRoute(storage: StorageConfig): Hono {
  const route = new Hono();

  route.get('/upload', (c) =>
    c.json({
      multipartThresholdBytes: storage.multipart.thresholdBytes,
      multipartPartSizeBytes: storage.multipart.partSizeBytes,
      multipartTtlSeconds: storage.multipart.ttlSeconds,
      maxObjectSizeBytes: storage.multipart.maxObjectSizeBytes,
    }),
  );

  return route;
}
