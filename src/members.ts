import { setTimeout as delay } from 'node:timers/promises';
import { isRecord, type MemberLookup } from './shared/types.js';

export interface LookupOptions {
  serviceId: string;
  apiKey: string;
  fetchImpl?: (url: URL, init: RequestInit & { signal: AbortSignal }) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  intervalMs?: number;
  ttlMs?: number;
  refreshFloorMs?: number;
  timeoutMs?: number;
}
interface Snapshot { members: Map<string, boolean>; checkedAt: number; completedAt: number }

// One shared refresh per process; never send this cache to the browser.
export function createMemberLookup({ serviceId, apiKey, fetchImpl = fetch,
  now = Date.now, sleep = (ms, signal) => delay(ms, undefined, { signal }),
  intervalMs = 1100, ttlMs = 30_000, refreshFloorMs = 5000, timeoutMs = 30_000 }: LookupOptions): MemberLookup {
  let snapshot: Snapshot | undefined;
  let pending: Promise<Snapshot> | undefined;
  let lastRequestAt = -Infinity;
  let retryAfter = 0;

  async function requestPage(url: URL, signal: AbortSignal): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await sleep(Math.max(0, lastRequestAt + intervalMs - now()), signal);
      signal.throwIfAborted();
      lastRequestAt = now();
      const response = await fetchImpl(url, {
        headers: { 'X-MICROCMS-API-KEY': apiKey, Accept: 'application/json' },
        signal, redirect: 'error', cache: 'no-store',
      });
      if (response.ok) return response.json();
      await response.body?.cancel();
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        const value = response.headers.get('retry-after');
        const seconds = value == null ? NaN : Number(value);
        const backoff = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value ?? '') - now();
        await sleep(Math.min(30_000, Math.max(response.status === 429 ? 10_000 : 1000,
          Number.isFinite(backoff) ? backoff : 0)), signal);
        continue;
      }
      // Do not include upstream response bodies, email addresses or credentials in errors.
      throw new Error('Member API unavailable');
    }
  }

  async function refresh() {
    const signal = AbortSignal.timeout(timeoutMs);
    const members = new Map<string, boolean>();
    const tokens = new Set<string>();
    let token: string | undefined;
    const checkedAt = now();
    do {
      const url = new URL(`https://${serviceId}.microcms-management.io/api/v1/members`);
      url.searchParams.set('limit', '100');
      if (token) url.searchParams.set('token', token);
      const page = await requestPage(url, signal);
      if (!isRecord(page) || !Array.isArray(page.members)) throw new Error('Invalid members response');
      for (const member of page.members as unknown[]) {
        if (!isRecord(member) || typeof member.email !== 'string' || typeof member.mfa !== 'boolean') {
          throw new Error('Invalid member');
        }
        // Exact email matching: do not merge distinct local parts by lowercasing.
        if (members.has(member.email)) throw new Error('Ambiguous member');
        members.set(member.email, member.mfa);
      }
      const nextToken = page.token;
      if (nextToken != null && (typeof nextToken !== 'string' || !nextToken || nextToken.length > 4096)) {
        throw new Error('Invalid pagination token');
      }
      token = typeof nextToken === 'string' ? nextToken : undefined;
      if (token && (tokens.has(token) || tokens.size >= 100)) throw new Error('Invalid pagination');
      if (token) tokens.add(token);
    } while (token);
    snapshot = { members, checkedAt, completedAt: now() };
    return snapshot;
  }

  return async function lookup(email, forceRefresh = false) {
    const age = snapshot ? now() - snapshot.completedAt : Infinity;
    let data;
    if (pending) data = await pending;
    else if (snapshot && age < (forceRefresh ? refreshFloorMs : ttlMs)) data = snapshot;
    else {
      if (now() < retryAfter) throw new Error('Retry later');
      pending = refresh().catch(error => {
        snapshot = undefined; // Never reuse a stale success after a failed refresh.
        retryAfter = now() + 5000;
        throw error;
      }).finally(() => { pending = undefined; });
      data = await pending;
    }
    if (!data.members.has(email)) return { status: 'unknown' };
    return { status: data.members.get(email) ? 'enabled' : 'disabled',
      checkedAt: new Date(data.checkedAt).toISOString() };
  };
}
