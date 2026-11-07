import { readConfig } from './config.js';
import { createApp } from './app.js';

try {
  const config = readConfig();
  const server = await createApp(config);
  server.on('error', () => { console.error('サーバーを起動できませんでした。待受アドレスとポートを確認してください。'); process.exitCode = 1; });
  server.listen(config.port, config.bindAddress, () => console.log(`Listening on ${config.appOrigin}`));
  for (const event of ['SIGTERM', 'SIGINT']) process.on(event, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'サーバーを起動できませんでした。');
  process.exitCode = 1;
}
