// Ad-hoc verification harness for the storage-provider module (issue #4).
// Not part of the shipped product — run manually against MinIO/R2/S3 to
// confirm the seam behaves as advertised. Not committed to package.json
// scripts on purpose; the project ships zero tests for v1.
//
// Usage:
//   S3_ENDPOINT=http://localhost:9100 \
//   S3_ACCESS_KEY_ID=fhadmin S3_SECRET_ACCESS_KEY=fhadmin-secret \
//   S3_BUCKET=fileharbor-test S3_FORCE_PATH_STYLE=true S3_REGION=auto \
//   node --experimental-strip-types scripts/verify-storage.mjs

import { createStorageProvider, verifyStorage } from '../apps/server/src/storage/index.ts';
import { loadConfig } from '../apps/server/src/config.ts';
import { writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';

const cfg = loadConfig().storage;
const storage = createStorageProvider(cfg);

console.log('1. verifyStorage (HeadBucket)...');
await verifyStorage(storage, cfg);
console.log('   ok');

const key = `verify/${Date.now()}-hello.txt`;
const payload = 'hello-fileharbor-storage-seam\n';
const tmp = `/tmp/fh-verify-${Date.now()}.txt`;
writeFileSync(tmp, payload);

console.log(`2. presignPut → curl upload (key=${key})...`);
const put = await storage.presignPut(key, { contentType: 'text/plain' });
console.log(`   url ttl until ${put.expiresAt.toISOString()}`);
execSync(`curl -sS -X PUT -H "Content-Type: text/plain" --upload-file ${tmp} "${put.url}"`, {
  stdio: 'inherit',
});
console.log('   uploaded');

console.log('3. headObject (existing)...');
const info = await storage.headObject(key);
if (!info) throw new Error('headObject returned null for existing object');
console.log(`   size=${info.size} contentType=${info.contentType} etag=${info.etag}`);
if (info.size !== payload.length)
  throw new Error(`size mismatch: ${info.size} vs ${payload.length}`);
if (info.contentType !== 'text/plain') throw new Error(`contentType mismatch: ${info.contentType}`);

console.log('4. presignGet → curl download...');
const get = await storage.presignGet(key);
const got = execSync(`curl -sS "${get.url}"`).toString();
if (got !== payload) throw new Error(`payload mismatch: got ${JSON.stringify(got)}`);
console.log('   bytes match');

console.log('5. headObject (missing) returns null...');
const missing = await storage.headObject('verify/does-not-exist-' + Date.now());
if (missing !== null)
  throw new Error('expected null for missing object, got ' + JSON.stringify(missing));
console.log('   null');

console.log('6. deleteObject...');
await storage.deleteObject(key);
const after = await storage.headObject(key);
if (after !== null) throw new Error('object still present after delete');
console.log('   gone');

unlinkSync(tmp);
console.log('\nALL OK');
