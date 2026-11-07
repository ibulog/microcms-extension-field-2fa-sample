import { execFileSync, spawn } from 'node:child_process';

// The outer Node watcher restarts this build-and-run process when sources change.
execFileSync(process.execPath, ['scripts/build.ts'], { stdio: 'inherit' });
const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'dist/src/server.js'], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.kill(signal));
}
server.on('exit', code => process.exit(code ?? 0));
server.on('error', () => { console.error('開発サーバーを起動できませんでした。'); process.exitCode = 1; });
