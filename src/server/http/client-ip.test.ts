import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientIpResolver } from './client-ip';

async function ipOf(trustProxy: boolean, headers: Record<string, string>): Promise<string> {
  const app = new Hono().get('/', (c) => c.text(clientIpResolver(trustProxy)(c)));
  const res = await app.request('/', { headers });
  return res.text();
}

describe('clientIpResolver', () => {
  it('uses the first X-Forwarded-For entry behind a trusted proxy', async () => {
    expect(await ipOf(true, { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' })).toBe('198.51.100.4');
  });

  it('ignores X-Forwarded-For unless the proxy is trusted', async () => {
    // No Node socket in app.request(), so the remote address is unknown.
    expect(await ipOf(false, { 'x-forwarded-for': '198.51.100.4' })).toBe('unknown');
  });
});
