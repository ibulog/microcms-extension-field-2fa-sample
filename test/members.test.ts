import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberLookup, type LookupOptions } from '../src/members.js';

const email = 'member@example.com';
const page = (mfa: boolean, extra: Record<string, unknown> = {}) => Response.json({ members: [{ email, mfa }], ...extra });
function setup(fetchImpl: NonNullable<LookupOptions['fetchImpl']>, options: Partial<LookupOptions> = {}) {
  let time = 1_700_000_000_000;
  const waits: number[] = [];
  return { waits, advance(ms: number) { time += ms; }, lookup: createMemberLookup({
    serviceId: 'test-service', apiKey: 'secret', fetchImpl, now: () => time,
    sleep: async ms => { waits.push(ms); time += ms; }, ...options,
  }) };
}

test('paginates with encoded tokens, keeps credentials upstream, and distinguishes false from missing', async () => {
  const requests: { url: URL; options: RequestInit }[] = [];
  const { lookup, waits } = setup(async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? Response.json({ members: [], token: 'a+/=' }) : page(false);
  });
  assert.equal((await lookup(email)).status, 'disabled');
  assert.equal((await lookup('missing@example.com')).status, 'unknown');
  assert.equal(requests.length, 2);
  assert.ok(waits.includes(1100));
  assert.equal(requests[0].url.origin, 'https://test-service.microcms-management.io');
  assert.equal(requests[0].url.searchParams.get('limit'), '100');
  assert.equal(requests[1].url.searchParams.get('token'), 'a+/=');
  assert.equal(new Headers(requests[0].options.headers).get('X-MICROCMS-API-KEY'), 'secret');
  assert.equal(requests[0].options.redirect, 'error');
});

test('coalesces concurrent requests, caches, and explicitly refreshes after the cooldown', async () => {
  let calls = 0;
  const { lookup, advance } = setup(async () => page(++calls === 1));
  const results = await Promise.all([lookup(email), lookup(email), lookup(email)]);
  assert.ok(results.every(result => result.status === 'enabled'));
  assert.equal(calls, 1);
  await lookup(email, true);
  assert.equal(calls, 1);
  advance(5001);
  assert.equal((await lookup(email, true)).status, 'disabled');
  advance(30_001);
  await lookup(email);
  assert.equal(calls, 3);
});

test('failed refresh invalidates old results and throttles retries', async () => {
  let calls = 0;
  const { lookup, advance } = setup(async () => ++calls === 1 ? page(true) : new Response('SECRET ERROR', { status: 403 }));
  await lookup(email);
  advance(5001);
  await assert.rejects(lookup(email, true), /unavailable/);
  await assert.rejects(lookup(email), /Retry later/);
  assert.equal(calls, 2);
});

test('429 is retried with backoff and requests are spaced', async () => {
  let calls = 0;
  const { lookup, waits } = setup(async () => ++calls === 1
    ? new Response('', { status: 429, headers: { 'Retry-After': '12' } }) : page(true));
  assert.equal((await lookup(email)).status, 'enabled');
  assert.ok(waits.includes(12_000));
  assert.equal(calls, 2);
});

test('unknown MFA, duplicate emails, bad pagination, and partial results fail closed', async t => {
  const examples = [
    { members: [{ email, mfa: null }] },
    { members: [{ email, mfa: 'false' }] },
    { members: [{ email, mfa: true }, { email, mfa: false }] },
    { members: [] , token: 123 },
    { members: [], token: 'repeated' },
    { invalid: [] },
  ];
  for (const [index, body] of examples.entries()) await t.test(String(index), async () => {
    const { lookup } = setup(async () => Response.json(body));
    await assert.rejects(lookup(email));
  });
  let calls = 0;
  const { lookup } = setup(async () => ++calls === 1 ? page(true, { token: 'next' }) : new Response('', { status: 403 }));
  await assert.rejects(lookup(email));
});

test('email matching does not conflate local-part casing', async () => {
  const { lookup } = setup(async () => page(true));
  assert.equal((await lookup('Member@example.com')).status, 'unknown');
});

test('upstream requests have a real deadline', async () => {
  const lookup = createMemberLookup({ serviceId: 'test', apiKey: 'secret', timeoutMs: 20,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => resolve(page(true)), 200);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    }) });
  await assert.rejects(lookup(email), { name: 'TimeoutError' });
});
