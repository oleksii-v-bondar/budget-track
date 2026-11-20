import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

export type ClientIpResolver = (c: Context) => string;

/**
 * Client address used for login rate limiting. Behind a reverse proxy (TRUST_PROXY=true) it is the rightmost
 * non-empty X-Forwarded-For entry, which the trusted proxy appended (entries to its left are client-controlled);
 * otherwise the socket's remote address.
 */
export function clientIpResolver(trustProxy: boolean): ClientIpResolver {
  return (c) => {
    if (trustProxy) {
      const entries = c.req.header('x-forwarded-for')?.split(',') ?? [];
      const last = entries.map((entry) => entry.trim()).filter(Boolean).at(-1);
      if (last) return last;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
}
