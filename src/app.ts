import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createMemberLookup } from './members.js';
import { isEmail } from './shared/protocol.js';
import { isRecord, type MemberLookup } from './shared/types.js';
import type { AppConfig } from './config.js';

export async function createApp(config: AppConfig, { lookup = createMemberLookup(config) }: { lookup?: MemberLookup } = {}) {
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ].map(async ([path, file, type]) => [path, { type,
    body: (await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8'))
      .replaceAll('__MICROCMS_ORIGIN__', config.microcmsOrigin) }] as const)));

  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000,
    headersTimeout: 10_000, keepAliveTimeout: 5000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${config.microcmsOrigin}`);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.appOrigin.startsWith('https:')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.url === '/api/mfa') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(405, { status: 'unknown' }); }
        // Defense in depth only. The hosting edge MUST enforce the IP allowlist.
        if (req.headers.origin !== config.appOrigin ||
            (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
          return json(403, { status: 'unknown' });
        }
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          return json(415, { status: 'unknown' });
        }
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2048) { json(413, { status: 'unknown' }); return; }
          chunks.push(chunk);
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return json(400, { status: 'unknown' }); }
        if (!isRecord(body) || !isEmail(body.email) ||
            (body.refresh !== undefined && typeof body.refresh !== 'boolean')) {
          return json(400, { status: 'unknown' });
        }
        try { return json(200, await lookup(body.email, body.refresh === true)); }
        catch { return json(503, { status: 'unknown' }); }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD'); return json(405, { status: 'unknown' });
      }
      if (req.url === '/healthz') return json(200, { ok: true });
      const asset = assets.get(req.url ?? '');
      if (!asset) return json(404, { status: 'unknown' });
      res.writeHead(200, { 'Content-Type': asset.type });
      res.end(req.method === 'HEAD' ? undefined : asset.body);
    } catch {
      if (!res.headersSent && !res.destroyed) json(500, { status: 'unknown' });
      else res.end();
    }
  });
  return server;
}
