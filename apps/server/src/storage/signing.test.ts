import assert from 'node:assert/strict';
import test from 'node:test';

import { signCanonical, verifySignature, type CanonicalParams } from './signing.js';

const secret = 'test-secret';

test('canonical encoding is injective: a newline in contentType cannot shift fields', () => {
  const signed: CanonicalParams = {
    method: 'PUT',
    key: 'receive/l/u/f',
    exp: 9999999999,
    contentType: 'text/plain\n1000',
    contentLength: 1,
  };
  const forged: CanonicalParams = {
    ...signed,
    contentType: 'text/plain',
    contentLength: 1000,
    responseContentDisposition: '1\n',
  };
  assert.equal(verifySignature(forged, signCanonical(signed, secret), secret), false);
});

test('signatures round-trip for each method with its normal fields', () => {
  const exp = 9999999999;
  const cases: CanonicalParams[] = [
    { method: 'PUT', key: 'a/b', exp, contentType: 'text/plain', contentLength: 10 },
    { method: 'GET', key: 'a/b', exp, responseContentDisposition: 'attachment; filename="b"' },
    { method: 'DELETE', key: 'a/b', exp },
    { method: 'PUT-PART', key: 'a/b', exp, contentLength: 16, uploadId: 'abc', partNumber: 2 },
  ];
  for (const params of cases) {
    assert.equal(
      verifySignature(params, signCanonical(params, secret), secret),
      true,
      params.method,
    );
  }
});
