import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from '../logger';
import type { AppEnv } from './env';

/** Vite names the files in /assets after their content hash, so a URL there never changes its content. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

const isApi = (path: string) => path === '/api' || path.startsWith('/api/');

/** Paths the web app's router handles (/budget, /accounts/…): anything outside /assets that doesn't name a file. */
function isAppRoute(path: string): boolean {
  return !path.startsWith('/assets/') && !path.slice(path.lastIndexOf('/') + 1).includes('.');
}

/**
 * Serves the built PWA from `webDir` for GET and HEAD requests outside /api, with index.html for the app's own
 * routes (SPA fallback). Hashed assets are cached for a year; everything else (index.html, the service worker, the
 * manifest, icons) is revalidated on every load, so a new release reaches the browser. Without a build only the API
 * is served.
 */
export function serveWeb(webDir: string, logger: Logger): MiddlewareHandler<AppEnv> {
  if (!existsSync(join(webDir, 'index.html'))) {
    logger.warn({ webDir }, 'web app not built (npm run build:web); serving the API only');
    return (_c, next) => next();
  }
  const file = serveStatic({ root: webDir });
  const index = serveStatic({ root: webDir, path: 'index.html' });
  const notFound = async () => {};
  return async (c, next) => {
    const path = c.req.path;
    if (isApi(path)) return next();
    const res = (await file(c, notFound)) ?? (isAppRoute(path) ? await index(c, notFound) : undefined);
    if (!res) return next();
    res.headers.set('Cache-Control', path.startsWith('/assets/') ? IMMUTABLE : 'no-cache');
    return res;
  };
}
