import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { ApiErrorBody } from '../../shared/http';
import { accountRoutes } from '../accounts/account-routes';
import { loginRoutes } from '../auth/login-routes';
import { bankRoutes } from '../bank/bank-routes';
import { budgetRoutes } from '../budget/budget-routes';
import { categoryRoutes } from '../categories/category-routes';
import { groupRoutes } from '../categories/group-routes';
import type { Clock } from '../clock';
import { redoRoutes, undoRoutes } from '../commands/undo-routes';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { FxRates } from '../fx/fx-rates';
import { fxRoutes } from '../fx/fx-routes';
import type { Logger } from '../logger';
import { payeeRoutes } from '../payees/payee-routes';
import { transactionRoutes } from '../transactions/transaction-routes';
import type { AppEnv } from './env';
import { AppError, errorHandler } from './errors';
import { csrfGuard, noStore, requestLogger } from './middleware';
import { serveWeb } from './web';

export interface AppDeps {
  db: Db;
  config: Config;
  clock: Clock;
  logger: Logger;
  /** NBP rates (spec §9). Quote before a command or read transaction starts, never inside one. */
  fx: FxRates;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()
    .use(requestId())
    .use(requestLogger(deps.logger))
    .use(
      secureHeaders({
        contentSecurityPolicy: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
        referrerPolicy: 'no-referrer',
        xFrameOptions: 'DENY',
      }),
    )
    .use('/api/*', noStore())
    .use('/api/*', csrfGuard())
    .use(
      '/api/*',
      bodyLimit({
        maxSize: 64 * 1024,
        onError: () => {
          throw new AppError(413, 'payload_too_large', 'Request body is too large.');
        },
      }),
    )
    .get('/healthz', async (c) => {
      try {
        await deps.db.execute(sql`select 1`);
        return c.json({ status: 'ok' as const });
      } catch (err) {
        c.var.logger.warn({ err }, 'health check failed');
        return c.json({ status: 'unavailable' as const }, 503);
      }
    })
    .route('/api/auth', loginRoutes(deps))
    // Every router below is mounted on its own prefix and starts with .use('*', requireSession(deps)), so each new
    // route is private by default (app.test.ts walks app.routes to keep it that way).
    .route('/api/undo', undoRoutes(deps))
    .route('/api/redo', redoRoutes(deps))
    .route('/api/accounts', accountRoutes(deps))
    .route('/api/category-groups', groupRoutes(deps))
    .route('/api/categories', categoryRoutes(deps))
    .route('/api/budget', budgetRoutes(deps))
    .route('/api/payees', payeeRoutes(deps))
    .route('/api/transactions', transactionRoutes(deps))
    .route('/api/fx', fxRoutes(deps))
    .route('/api/bank', bankRoutes(deps));

  // Outside the chain above, so the RPC type (App) has only API routes; every API route matches first.
  app.get('*', serveWeb(deps.config.webDir, deps.logger));
  app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
  app.onError(errorHandler);
  return app;
}

export type App = ReturnType<typeof createApp>;
