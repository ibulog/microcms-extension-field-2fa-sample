import type { InitialData } from '../shared/protocol.js';
import { isKnownMfaResult } from '../shared/types.js';
import { connectFieldExtension, updateFieldHeight } from './field-extension.js';

function element<T extends Element>(selector: string, type: { new(): T }): T {
  const value = document.querySelector(selector);
  if (!(value instanceof type)) throw new Error(`Missing element: ${selector}`);
  return value;
}

const allowedOrigin = element('meta[name="microcms-origin"]', HTMLMetaElement).content;
const card = element('#card', HTMLElement);
const message = element('#message', HTMLParagraphElement);
const description = element('#description', HTMLParagraphElement);
const guide = element('#guide', HTMLAnchorElement);
const checkedAt = element('#checked-at', HTMLParagraphElement);
const retry = element('#retry', HTMLButtonElement);
let context: InitialData | undefined;
let controller: AbortController | undefined;
let version = 0;
let cooldown: ReturnType<typeof setTimeout> | undefined;

function resize() {
  if (!context) return;
  updateFieldHeight(context.id, allowedOrigin);
}

function render(state: 'loading' | 'enabled' | 'disabled' | 'unknown', timestamp?: string) {
  card.dataset.state = state;
  card.setAttribute('aria-busy', String(state === 'loading'));
  guide.hidden = state !== 'disabled';
  const text = {
    loading: ['設定状況を確認しています…', '取得が完了するまでお待ちください。'],
    enabled: ['2要素認証は設定済み', 'このアカウントでは2要素認証が有効です。'],
    disabled: ['2要素認証が未設定です。', '以下のドキュメントを参照して設定してください。'],
    unknown: ['設定状況を確認できませんでした。', context?.email
      ? '時間をおいて再確認してください。解決しない場合は管理者にお問い合わせください。'
      : 'microCMSのコンテンツ編集画面から開き直してください。'],
  };
  [message.textContent, description.textContent] = text[state];
  checkedAt.textContent = timestamp ? `確認日時：${new Date(timestamp).toLocaleString('ja-JP')}` : '';
  retry.disabled = state === 'loading' || !context?.email;
  resize();
}

async function check(refresh = false) {
  clearTimeout(cooldown);
  const current = ++version;
  controller?.abort();
  controller = new AbortController();
  const requestController = controller;
  if (!context?.email) { render('unknown'); return; }
  render('loading');
  const timeout = setTimeout(() => requestController.abort(), 35_000);
  try {
    const response = await fetch('/api/mfa', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: context.email, refresh }),
      signal: requestController.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error('Unavailable');
    const result: unknown = await response.json();
    if (current !== version) return;
    if (!isKnownMfaResult(result)) {
      render('unknown');
    } else render(result.status, result.checkedAt);
  } catch {
    if (current === version) render('unknown');
  } finally {
    clearTimeout(timeout);
    if (current === version) {
      retry.disabled = true;
      cooldown = setTimeout(() => { retry.disabled = !context?.email; }, 5000);
    }
  }
}

const initialTimeout = setTimeout(() => render('unknown'), 10_000);
const disconnect = connectFieldExtension(allowedOrigin, next => {
  clearTimeout(initialTimeout);
  if (context?.id === next.id && context.email === next.email) return;
  context = next;
  check();
});
retry.addEventListener('click', () => check(true));
const observer = new ResizeObserver(resize);
observer.observe(document.body);
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  disconnect();
  observer.disconnect();
  controller?.abort();
  clearTimeout(initialTimeout);
  clearTimeout(cooldown);
}, { once: true });
