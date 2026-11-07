import test, { type TestContext } from 'node:test';
import type { MemberLookup } from '../src/shared/types.js';
import type { IncomingMessage } from '../src/shared/protocol.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { readInitialMessage } from '../src/shared/protocol.js';

const config = readConfig({ MICROCMS_SERVICE_ID: 'test-service', MICROCMS_API_KEY: 'TOP-SECRET', APP_ORIGIN: 'https://extension.example.com' });
async function serverFor(t: TestContext, lookup: MemberLookup) {
  const server = await createApp(config, { lookup });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const request = (body: unknown = { email: 'member@example.com' }, origin = config.appOrigin): { method: string; headers: Record<string, string>; body: string } => ({
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('API returns only status and timestamp; secrets and source files are never served', async t => {
  const base = await serverFor(t, async () => ({ status: 'enabled', checkedAt: '2026-11-05T00:00:00.000Z' }));
  const response = await fetch(`${base}/api/mfa`, request());
  assert.deepEqual(await response.json(), { status: 'enabled', checkedAt: '2026-11-05T00:00:00.000Z' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  for (const path of ['/', '/app.js', '/style.css']) {
    const asset = await fetch(base + path);
    assert.equal(asset.status, 200);
    assert.ok(!(await asset.text()).includes('TOP-SECRET'));
    assert.match(asset.headers.get('content-security-policy') ?? '', /frame-ancestors https:\/\/test-service.microcms.io/);
  }
  for (const path of ['/.env', '/src/config.ts', '/src/members.ts', '/app.js.map', '/protocol.js', '/package.json']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
});

test('rejects bad origins, forged forwarded headers, unsupported methods, and invalid inputs before lookup', async t => {
  let calls = 0;
  const base = await serverFor(t, async () => { calls++; return { status: 'unknown' }; });
  const badOrigin = request(undefined, 'https://evil.example');
  badOrigin.headers['X-Forwarded-For'] = '127.0.0.1';
  assert.equal((await fetch(base + '/api/mfa', badOrigin)).status, 403);
  assert.equal((await fetch(base + '/api/mfa', request(undefined, ''))).status, 403);
  assert.equal((await fetch(base + '/api/mfa')).status, 405);
  assert.equal((await fetch(base + '/api/mfa', request({ email: 'bad' }))).status, 400);
  assert.equal((await fetch(base + '/api/mfa', request({ email: 'a@b', refresh: 'true' }))).status, 400);
  const oversized = request({ email: 'x'.repeat(3000) });
  assert.equal((await fetch(base + '/api/mfa', oversized)).status, 413);
  const malformed = request(); malformed.body = '{';
  assert.equal((await fetch(base + '/api/mfa', malformed)).status, 400);
  const wrongType = request(); wrongType.headers['Content-Type'] = 'text/plain';
  assert.equal((await fetch(base + '/api/mfa', wrongType)).status, 415);
  assert.equal(calls, 0);
});

test('upstream errors do not leak into the browser', async t => {
  const base = await serverFor(t, async () => { throw new Error('TOP-SECRET user@example.com'); });
  const response = await fetch(base + '/api/mfa', request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unknown' });
});

test('postMessage requires the exact origin, parent source, trusted event, action, and id', () => {
  const parent = {};
  const good = { isTrusted: true, source: parent, origin: config.microcmsOrigin,
    data: { id: 'field-1', action: 'MICROCMS_GET_DEFAULT_DATA', user: { email: 'member@example.com' } } };
  const read = (event: IncomingMessage) => readInitialMessage(event, parent, config.microcmsOrigin);
  assert.deepEqual(read(good), { id: 'field-1', email: 'member@example.com' });
  for (const patch of [{ source: {} }, { isTrusted: false }, { origin: 'https://test-service.microcms.io.evil.com' },
    { data: null }, { data: { ...good.data, action: 'OTHER' } }, { data: { ...good.data, id: '' } }]) {
    assert.equal(read({ ...good, ...patch }), null);
  }
  assert.deepEqual(read({ ...good, data: { ...good.data, user: {} } }), { id: 'field-1', email: null });
});

test('production configuration requires HTTPS and rejects origin injection', () => {
  const env = { MICROCMS_SERVICE_ID: 'test-service', MICROCMS_API_KEY: 'secret', APP_ORIGIN: 'http://localhost:3000' };
  assert.equal(readConfig(env).appOrigin, 'http://localhost:3000');
  for (const value of ['http://example.com', 'https://example.com/path', 'https://user:pass@example.com', 'javascript:alert(1)']) {
    assert.throws(() => readConfig({ ...env, APP_ORIGIN: value }));
  }
  assert.throws(() => readConfig({ ...env, MICROCMS_SERVICE_ID: 'x; frame-ancestors *' }));
  assert.throws(() => readConfig({ ...env, MICROCMS_API_KEY: '' }));
});
