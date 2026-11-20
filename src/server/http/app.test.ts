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

  it('rejects mutating /api requests without the CSRF header', async () => {
    const { app } = createTestApp(t.db);
    const res = await app.request('/api/nope', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'csrf', message: 'Missing X-Requested-With header.' });
    const withHeader = await new TestClient(app).post('/api/nope');
    expect(withHeader.status).toBe(404);
  });
});
