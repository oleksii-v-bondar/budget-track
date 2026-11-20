import type { MiddlewareHandler } from 'hono';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../shared/http';
import type { Logger } from '../logger';
import type { AppEnv } from './env';
import { AppError } from './errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Rejects state-changing requests without the custom header; browsers can't add it cross-site without CORS. */
export function csrfGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && c.req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
      throw new AppError(403, 'csrf', `Missing ${CSRF_HEADER} header.`);
    }
    await next();
  };
}

/** Puts a request-scoped child logger on the context and logs one line per request. */
export function requestLogger(base: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const logger = base.child({ requestId: c.var.requestId });
    c.set('logger', logger);
    const started = performance.now();
    await next();
    logger.info(
      { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) },
      'request',
    );
  };
}
