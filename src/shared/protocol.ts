import { isRecord } from './types.js';

export interface InitialData { id: string; email: string | null }
export interface IncomingMessage {
  isTrusted: boolean;
  source: unknown;
  origin: string;
  data: unknown;
}

export function isEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value);
}

export function readInitialMessage(event: IncomingMessage, parentWindow: unknown, allowedOrigin: string): InitialData | null {
  if (event.isTrusted !== true || event.source !== parentWindow || event.origin !== allowedOrigin ||
      !isRecord(event.data) || event.data.action !== 'MICROCMS_GET_DEFAULT_DATA') return null;
  const { id, user } = event.data;
  if (typeof id !== 'string' || !id || id.length > 256) return null;
  return { id, email: isRecord(user) && isEmail(user.email) ? user.email : null };
}
