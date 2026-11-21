import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { E2E_SETUP_TOKEN } from './env';

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  server.close();
  await once(server, 'close');
  return port;
}

async function waitUntilHealthy(url: string, server: ChildProcess): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw new Error(`the server exited with code ${server.exitCode}`);
    const ok = await fetch(url).then(
      (res) => res.ok,
      () => false,
    );
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`the server did not become healthy at ${url}`);
}

/**
 * Starts Postgres 16 (Testcontainers) and the built server (dist/) on a free port, like the Docker image runs it.
 * Docker Desktop's Enhanced Container Isolation blocks Ryuk, so the reaper is off and the teardown stops everything.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync('dist/server/main.js') || !existsSync('dist/web/index.html')) {
    throw new Error('Build the app first: `npm run test:e2e` runs `npm run build` before the tests.');
  }
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const database = await new PostgreSqlContainer('postgres:16-alpine').start();
  let server: ChildProcess | undefined;
  try {
    const port = await freePort();
    server = spawn(process.execPath, ['--enable-source-maps', 'dist/server/main.js'], {
      env: {
        ...process.env,
        DATABASE_URL: database.getConnectionUri(),
        ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        SETUP_TOKEN: E2E_SETUP_TOKEN,
        PORT: String(port),
        // Plain http on 127.0.0.1.
        COOKIE_SECURE: 'false',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    process.env.E2E_BASE_URL = `http://127.0.0.1:${port}`;
    await waitUntilHealthy(`${process.env.E2E_BASE_URL}/healthz`, server);
  } catch (error) {
    server?.kill();
    await database.stop();
    throw error;
  }
  const running = server;
  return async () => {
    if (running.exitCode === null) {
      running.kill('SIGTERM');
      await once(running, 'exit');
    }
    await database.stop();
  };
}
