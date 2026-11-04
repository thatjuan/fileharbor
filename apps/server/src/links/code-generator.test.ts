import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../db/client.js';
import { sendLinks } from '../db/schema.js';
import type { StorageProvider } from '../storage/index.js';
import { generateCode, isPlausibleCode } from './code-generator.js';
import { createSendLinksModule } from './send-links.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../drizzle');

test('generateCode mints 12-character codes by default', () => {
  assert.match(generateCode(), /^[0-9A-HJKMNP-TV-Z]{12}$/);
});

test('isPlausibleCode accepts 8- and 12-character codes in any case', () => {
  assert.equal(isPlausibleCode('7K3M9QX2'), true);
  assert.equal(isPlausibleCode(generateCode()), true);
  assert.equal(isPlausibleCode('7k3m9qx2abcd'), true);
});

test('isPlausibleCode rejects empty, overlong and out-of-alphabet input', () => {
  assert.equal(isPlausibleCode(''), false);
  assert.equal(isPlausibleCode('a'.repeat(17)), false);
  assert.equal(isPlausibleCode('abc$def0'), false);
});

test('legacy 8-character codes still resolve', async () => {
  const db = openDatabase(':memory:', migrationsFolder);
  db.insert(sendLinks)
    .values({
      id: 'legacy-link',
      code: 'AB2CD3EF',
      label: 'legacy',
      createdAt: Math.floor(Date.now() / 1000),
    })
    .run();
  // `getByCode` is pure DB; storage is never touched.
  const module = createSendLinksModule(db, {} as StorageProvider);

  const link = await module.getByCode('ab2cd3ef');
  assert.equal(link?.id, 'legacy-link');
});
