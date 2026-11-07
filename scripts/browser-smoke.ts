// Optional real-browser check. Fixtures are served only by this test process.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { MfaResult } from '../src/shared/types.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

const profile = await mkdtemp(join(tmpdir(), 'mfa-browser-'));
const server = createServer();
let chrome: ChildProcess | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let state: MfaResult['status'] = 'enabled';
  let calls = 0;
  const slow: { release?: () => void } = {};
  app = await createApp({ serviceId: 'fixture', apiKey: 'TEST-KEY', appOrigin: origin, microcmsOrigin: origin }, {
    lookup: async email => {
      calls++;
      if (email === 'slow@example.com') await new Promise<void>(resolve => { slow.release = resolve; });
      if (email === 'error@example.com') throw new Error('Simulated outage');
      if (state === 'unknown') return { status: 'unknown' };
      return { status: email === 'slow@example.com' ? 'disabled' : state, checkedAt: '2026-11-05T12:00:00.000Z' };
    },
  });
  const fixtureApp = app;
  server.on('request', (req, res) => {
    if (req.url === '/fixture') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>microCMS fixture</title></head>
        <body style="margin:24px;background:#f3f5f8;font-family:sans-serif"><iframe title="2要素認証" src="/" style="width:420px;height:300px;border:0"></iframe>
        <script>const frame=document.querySelector('iframe');window.messages=[];
        window.sendUser=email=>frame.contentWindow.postMessage({id:'fixture',action:'MICROCMS_GET_DEFAULT_DATA',user:{email}},location.origin);
        frame.onload=()=>sendUser('member@example.com');
        window.addEventListener('message',e=>{window.messages.push(e.data);if(e.data.action==='MICROCMS_UPDATE_STYLE')frame.style.height=e.data.message.height+'px'});
        </script></body></html>`);
    } else fixtureApp.emit('request', req, res);
  });

  const browser = spawn(process.env.CHROME_BIN || 'google-chrome', ['--headless', '--no-sandbox',
    '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--remote-debugging-pipe', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  chrome = browser;
  const input = browser.stdio[3];
  const output = browser.stdio[4];
  assert.ok(input instanceof Writable && output instanceof Readable);
  let sequence = 0;
  let buffer = '';
  interface CdpResults {
    'Target.createTarget': { targetId: string };
    'Target.attachToTarget': { sessionId: string };
    'Page.enable': Record<string, never>;
    'Emulation.setDeviceMetricsOverride': Record<string, never>;
    'Page.navigate': { frameId: string };
    'Page.captureScreenshot': { data: string };
    'Runtime.evaluate': { result: { value?: unknown }; exceptionDetails?: unknown };
  }
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  const command = <M extends keyof CdpResults>(method: M, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpResults[M]> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve: result => resolve(result as CdpResults[M]), reject, timeout });
    input.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
  output.on('data', chunk => {
    buffer += chunk.toString();
    let split;
    while ((split = buffer.indexOf('\0')) !== -1) {
      const payload = JSON.parse(buffer.slice(0, split)) as { id: number; error?: { message: string }; result: unknown };
      buffer = buffer.slice(split + 1);
      const request = pending.get(payload.id);
      if (!request) continue;
      pending.delete(payload.id);
      clearTimeout(request.timeout);
      if (payload.error) request.reject(new Error(payload.error.message));
      else request.resolve(payload.result);
    }
  });
  browser.stderr?.on('data', () => {});
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  await command('Page.enable', {}, sessionId);
  await command('Emulation.setDeviceMetricsOverride', { width: 500, height: 400, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = async (expression: string) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = (expression: string) => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+12000;const timer=setInterval(()=>{try{if(${expression}){clearInterval(timer);resolve(true)}else if(Date.now()>end){clearInterval(timer);reject(new Error('UI timeout'))}}catch{}},50)})`);
  const doc = `document.querySelector('iframe').contentDocument`;
  await command('Page.navigate', { url: origin + '/fixture' }, sessionId);
  await waitFor(`${doc}?.querySelector('#card')?.dataset.state === 'enabled'`);
  assert.equal(await evaluate(`${doc}.querySelector('#message').textContent`), '2要素認証は設定済み');
  assert.equal(await evaluate(`${doc}.querySelector('#guide').hidden`), true);
  assert.equal(calls, 1);
  await evaluate(`sendUser('member@example.com')`);
  const spoofFrame = `<script>parent.document.querySelector('iframe').contentWindow.postMessage({id:'spoof',action:'MICROCMS_GET_DEFAULT_DATA',user:{email:'attacker@example.com'}},location.origin)</script>`;
  await evaluate(`(() => { const sibling = document.createElement('iframe'); sibling.hidden = true; sibling.srcdoc = ${JSON.stringify(spoofFrame)}; document.body.append(sibling); })()`);
  await evaluate(`document.querySelector('iframe').contentWindow.postMessage({id:123,action:'MICROCMS_GET_DEFAULT_DATA',user:{email:'attacker@example.com'}},location.origin)`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls, 1, 'duplicate message must not refetch');
  assert.equal(await evaluate(`messages.some(m => m.action==='MICROCMS_UPDATE_STYLE' && (m.id==='spoof' || m.id===123))`), false,
    'invalid events must be rejected before the SDK sends an initial style message');
  await waitFor(`!${doc}.querySelector('#retry').disabled`);
  state = 'disabled';
  await evaluate(`${doc}.querySelector('#retry').click()`);
  await waitFor(`${doc}.querySelector('#card').dataset.state === 'disabled'`);
  assert.equal(await evaluate(`${doc}.querySelector('#message').textContent`), '2要素認証が未設定です。');
  assert.equal(await evaluate(`${doc}.querySelector('#guide').target`), '_blank');
  await mkdir('artifacts', { recursive: true });
  const screenshot = await command('Page.captureScreenshot', { format: 'png' }, sessionId);
  await writeFile('artifacts/disabled.png', Buffer.from(screenshot.data, 'base64'));
  await evaluate(`document.querySelector('iframe').style.width='280px'`);
  await waitFor(`${doc}.documentElement.scrollWidth <= 280`);
  const narrow = await command('Page.captureScreenshot', { format: 'png' }, sessionId);
  await writeFile('artifacts/narrow.png', Buffer.from(narrow.data, 'base64'));
  state = 'unknown';
  await evaluate(`sendUser('unknown@example.com')`);
  await waitFor(`${doc}.querySelector('#card').dataset.state === 'unknown'`);
  assert.equal(await evaluate(`${doc}.querySelector('#guide').hidden`), true);
  await evaluate(`sendUser(null)`);
  await waitFor(`${doc}.querySelector('#description').textContent.includes('編集画面')`);
  assert.equal(await evaluate(`${doc}.querySelector('#retry').disabled`), true);
  state = 'enabled';
  await evaluate(`sendUser('slow@example.com')`);
  for (let i = 0; !slow.release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(slow.release, 'slow request started');
  await evaluate(`sendUser('member@example.com')`);
  await waitFor(`${doc}.querySelector('#card').dataset.state === 'enabled'`);
  slow.release();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await evaluate(`${doc}.querySelector('#card').dataset.state`), 'enabled', 'stale response must not overwrite the new user');
  await evaluate(`sendUser('error@example.com')`);
  await waitFor(`${doc}.querySelector('#card').dataset.state === 'unknown'`);
  assert.equal(await evaluate(`messages.some(m => m.action==='MICROCMS_POST_DATA')`), false, 'display-only SDK integration must not save content');
  console.log('Browser checks passed: SDK initialization, source/payload guard, enabled, disabled, refresh, duplicate event, unknown, missing email, stale response, HTTP failure, display-only, 280px layout.');
} finally {
  if (chrome) {
    const exited = once(chrome, 'exit');
    chrome.kill('SIGTERM');
    await exited;
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  app?.closeAllConnections();
  await rm(profile, { recursive: true, force: true });
}
