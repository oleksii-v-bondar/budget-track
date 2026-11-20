import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { ApiErrorBody } from '../../shared/http';
import { accountRoutes } from '../accounts/account-routes';
import { loginRoutes } from '../auth/login-routes';
import { securityRoutes } from '../auth/security-routes';
import { setupRoutes } from '../auth/setup-routes';
import { categoryRoutes } from '../categories/category-routes';
import { groupRoutes } from '../categories/group-routes';
import type { Clock } from '../clock';
import { redoRoutes, undoRoutes } from '../commands/undo-routes';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Logger } from '../logger';
import type { ClientIpResolver } from './client-ip';
import type { AppEnv } from './env';
import { AppError, errorHandler } from './errors';
import { csrfGuard, noStore, requestLogger } from './middleware';

export interface AppDeps {
  db: Db;
  config: Config;
  clock: Clock;
  logger: Logger;
  clientIp: ClientIpResolver;
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
    .route('/api/auth', setupRoutes(deps))
    .route('/api/auth', loginRoutes(deps))
    .route('/api/auth', securityRoutes(deps))
    // Every router below is mounted on its own prefix and starts with .use('*', requireSession(deps)), so each new
    // route is private by default (app.test.ts walks app.routes to keep it that way).
    .route('/api/undo', undoRoutes(deps))
    .route('/api/redo', redoRoutes(deps))
    .route('/api/accounts', accountRoutes(deps))
    .route('/api/category-groups', groupRoutes(deps))
    .route('/api/categories', categoryRoutes(deps));

  app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
  app.onError(errorHandler);
  return app;
}

export type App = ReturnType<typeof createApp>;
