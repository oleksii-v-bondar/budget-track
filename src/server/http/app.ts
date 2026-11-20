import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { ApiErrorBody } from '../../shared/http';
import { setupRoutes } from '../auth/setup-routes';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Logger } from '../logger';
import type { ClientIpResolver } from './client-ip';
import type { AppEnv } from './env';
import { errorHandler } from './errors';
import { csrfGuard, requestLogger } from './middleware';

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
    .use('/api/*', csrfGuard())
    .get('/healthz', async (c) => {
      try {
        await deps.db.execute(sql`select 1`);
        return c.json({ status: 'ok' as const });
      } catch (err) {
        c.var.logger.warn({ err }, 'health check failed');
        return c.json({ status: 'unavailable' as const }, 503);
      }
    })
    .route('/api/auth', setupRoutes(deps));

  app.notFound((c) => c.json<ApiErrorBody>({ code: 'not_found', message: 'Not found.' }, 404));
  app.onError(errorHandler);
  return app;
}

export type App = ReturnType<typeof createApp>;
