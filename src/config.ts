export interface AppConfig {
  serviceId: string;
  apiKey: string;
  appOrigin: string;
  microcmsOrigin: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig & { port: number; bindAddress: string } {
  const serviceId = env.MICROCMS_SERVICE_ID;
  const apiKey = env.MICROCMS_API_KEY;
  if (!serviceId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(serviceId)) {
    throw new Error('MICROCMS_SERVICE_ID を設定してください。');
  }
  if (!apiKey || /[\r\n]/.test(apiKey)) {
    throw new Error('MICROCMS_API_KEY を設定してください。');
  }
  let origin;
  try { origin = new URL(env.APP_ORIGIN ?? ''); } catch {
    throw new Error('APP_ORIGIN を設定してください。');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.username || origin.password || origin.search || origin.hash ||
      origin.pathname !== '/' || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))) {
    throw new Error('APP_ORIGIN は公開先のHTTPSオリジンを指定してください（ローカルのみHTTP可）。');
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT が不正です。');
  return { serviceId, apiKey, appOrigin: origin.origin,
    microcmsOrigin: `https://${serviceId}.microcms.io`,
    port, bindAddress: env.BIND_ADDRESS || '127.0.0.1' };
}
