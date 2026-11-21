import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client';
import { createTestApp } from '../test/app';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});

describe('GET /healthz', () => {
  it('reports ok when the database answers', async () => {
    const { client } = createTestApp(t.db);
    const res = await client.get('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('reports 503 when the database is down', async () => {
    const brokenDb = { execute: () => Promise.reject(new Error('connection refused')) } as unknown as Db;
    const { client } = createTestApp(brokenDb);
    const res = await client.get('/healthz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable' });
  });
});

describe('cross-cutting behaviour', () => {
  it('sets security headers and a request id on every response', async () => {
    const { client } = createTestApp(t.db);
    const res = await client.get('/healthz');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers unknown routes with a JSON 404', async () => {
    const { client } = createTestApp(t.db);
    const res = await client.get('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'not_found', message: 'Not found.' });
  });

  it('refuses request bodies over 64 KB', async () => {
    const { client } = createTestApp(t.db);
    const res = await client.post('/api/auth/login', { password: 'x'.repeat(100 * 1024), totpCode: '123456' });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: 'payload_too_large', message: 'Request body is too large.' });
  });

  it('tells caches not to store API responses', async () => {
    const { client } = createTestApp(t.db);
    const res = await client.get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects mutating /api requests without the CSRF header', async () => {
    const { app } = createTestApp(t.db);
    const res = await app.request('/api/nope', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'csrf', message: 'Missing X-Requested-With header.' });
    const withHeader = await new TestClient(app).post('/api/nope');
    expect(withHeader.status).toBe(404);
  });
});

describe('route guard', () => {
  it('requires a session on every /api route outside /api/auth (deny by default)', async () => {
    const { app, client } = createTestApp(t.db);
    const isAuth = (path: string) => path === '/api/auth' || path.startsWith('/api/auth/');
    const routes = app.routes
      .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/') && !isAuth(r.path))
      .map((r) => `${r.method} ${r.path}`);
    expect(routes).toEqual(
      expect.arrayContaining([
        'GET /api/undo',
        'GET /api/budget/:month',
        'POST /api/budget/:month/auto-assign',
        'PUT /api/categories/:id/target',
        'DELETE /api/categories/:id/target',
        'POST /api/categories/:id/target/snooze',
        'DELETE /api/categories/:id/target/snooze',
        'GET /api/fx/rates/:currency/:date',
      ]),
    );

    const responses = [];
    for (const route of routes) {
      const [method, path] = route.split(' ') as [string, string];
      const url = path.replace(/:[^/]+/g, crypto.randomUUID());
      const res = await client.send(method, url, method === 'GET' ? undefined : {});
      responses.push({ route, status: res.status, body: await res.json() });
    }
    const unauthorized = { status: 401, body: { code: 'unauthorized', message: 'Please sign in.' } };
    expect(responses).toEqual(routes.map((route) => ({ route, ...unauthorized })));
  });
});
