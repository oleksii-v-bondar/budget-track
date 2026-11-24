import { serve } from '@hono/node-server';
import { monthIn, systemClock } from './clock';
import { loadConfig } from './config';
import { createDatabase } from './db/client';
import { runMigrations } from './db/migrate';
import { ensureBudget } from './db/seed';
import { nbpRates } from './fx/fx-rates';
import { startAutoSync } from './bank/bank-sync';
import { type AppDeps, createApp } from './http/app';
import { createLogger } from './logger';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const database = createDatabase(config.databaseUrl);

  await runMigrations(database.db, config.migrationsDir);
  logger.info('database migrations applied');
  await ensureBudget(database.db, monthIn(config.timeZone, systemClock.now()));

  const deps: AppDeps = {
    db: database.db,
    config,
    clock: systemClock,
    logger,
    fx: nbpRates({
      db: database.db,
      logger,
      clock: systemClock,
      timeZone: config.timeZone,
      baseUrl: config.nbpBaseUrl,
    }),
  };
  const app = createApp(deps);
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port }, 'listening');
  });
  if (!config.enableBanking) logger.info('bank connections are off (no ENABLE_BANKING_APP_ID or no readable key file)');
  const stopAutoSync = config.enableBanking ? startAutoSync(deps) : () => {};

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    stopAutoSync();
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
