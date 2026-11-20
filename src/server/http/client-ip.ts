import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

export type ClientIpResolver = (c: Context) => string;

/**
 * Client address used for login rate limiting. Behind a reverse proxy (TRUST_PROXY=true) it is the first
 * X-Forwarded-For entry; otherwise the socket's remote address.
 */
export function clientIpResolver(trustProxy: boolean): ClientIpResolver {
  return (c) => {
    if (trustProxy) {
      const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (first) return first;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
}
