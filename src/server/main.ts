import { serve } from '@hono/node-server';
import { systemClock } from './clock';
import { loadConfig } from './config';
import { createDatabase } from './db/client';
import { runMigrations } from './db/migrate';
import { createApp } from './http/app';
import { clientIpResolver } from './http/client-ip';
import { createLogger } from './logger';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const database = createDatabase(config.databaseUrl);

  await runMigrations(database.db, config.migrationsDir);
  logger.info('database migrations applied');

  const app = createApp({
    db: database.db,
    config,
    clock: systemClock,
    logger,
    clientIp: clientIpResolver(config.trustProxy),
  });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port }, 'listening');
  });

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      database
        .close()
        .catch((err: unknown) => logger.error({ err }, 'error closing the database'))
        .finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  // The logger may not exist yet (e.g. invalid configuration), so print plainly.
  console.error(err);
  process.exit(1);
});
