import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from './config.js';

/** Runs `loadConfig` against a minimal test env in a throwaway data dir, capturing warnings. */
function load(extra: Record<string, string>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fileharbor-config-'));
  const warn = mock.method(console, 'warn', () => {});
  const log = mock.method(console, 'log', () => {});
  try {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      BETTER_AUTH_SECRET: 'test-secret',
      STORAGE_SIGNING_SECRET: 'test-signing-secret',
      ...extra,
    });
    const warnings = warn.mock.calls.map((call) => String(call.arguments[0]));
    return { config, warnings };
  } finally {
    warn.mock.restore();
    log.mock.restore();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('tunnel mode trusts CF-Connecting-IP and binds loopback by default', () => {
  const { config } = load({
    CLOUDFLARE_API_TOKEN: 'token',
    CLOUDFLARE_TUNNEL_DOMAIN: 'files.example.com',
  });
  assert.deepEqual(config.security.clientIpSource, { kind: 'header', header: 'cf-connecting-ip' });
  assert.equal(config.security.trustProxyHeaders, true);
  assert.equal(config.bindHost, '127.0.0.1');
});

test('no proxy settings use the socket and bind all interfaces', () => {
  const { config, warnings } = load({});
  assert.deepEqual(config.security.clientIpSource, { kind: 'socket' });
  assert.equal(config.security.trustProxyHeaders, false);
  assert.equal(config.bindHost, '0.0.0.0');
  assert.deepEqual(warnings, []);
});

test('legacy SECURITY_TRUST_PROXY_HEADERS=true reads one XFF hop and warns', () => {
  const { config, warnings } = load({ SECURITY_TRUST_PROXY_HEADERS: 'true' });
  assert.deepEqual(config.security.clientIpSource, { kind: 'xff', trustedHops: 1 });
  assert.equal(config.security.trustProxyHeaders, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /SECURITY_CLIENT_IP_SOURCE/);
});

test('explicit xff source honors SECURITY_XFF_TRUSTED_HOPS', () => {
  const { config } = load({ SECURITY_CLIENT_IP_SOURCE: 'xff', SECURITY_XFF_TRUSTED_HOPS: '2' });
  assert.deepEqual(config.security.clientIpSource, { kind: 'xff', trustedHops: 2 });
});

test('an unknown SECURITY_CLIENT_IP_SOURCE fails fast and lists the valid values', () => {
  assert.throws(
    () => load({ SECURITY_CLIENT_IP_SOURCE: 'x-forwarded-for' }),
    /socket, cf-connecting-ip, x-real-ip, xff/,
  );
});
