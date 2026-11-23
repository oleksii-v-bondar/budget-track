import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { session } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { TEST_PASSWORD, TEST_USERNAME } from '../test/config';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';
import { SESSION_COOKIE } from './sessions';

let t: TestDatabase;
let ctx: TestApp;
beforeAll(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db);
});
afterAll(async () => {
  await t.drop();
});

async function login(client: TestClient, body: Record<string, unknown>) {
  const res = await client.post('/api/auth/login', body);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const status = async (client: TestClient) => (await client.get('/api/auth/status')).json();

describe('POST /api/auth/login', () => {
  it('signs in with the username and password from the environment', async () => {
    const client = new TestClient(ctx.app);
    expect(await status(client)).toEqual({ authenticated: false });
    expect(await login(client, { username: TEST_USERNAME, password: TEST_PASSWORD })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(client.cookie(SESSION_COOKIE)).toBeDefined();
    expect(await status(client)).toEqual({ authenticated: true });
  });

  it('rejects a wrong username or password with the same message', async () => {
    for (const body of [
      { username: TEST_USERNAME, password: 'not my password' },
      { username: 'admin', password: TEST_PASSWORD },
    ]) {
      const client = new TestClient(ctx.app);
      expect(await login(client, body)).toEqual({
        status: 401,
        body: { code: 'invalid_credentials', message: 'Wrong username or password.' },
      });
      expect(client.cookie(SESSION_COOKIE)).toBeUndefined();
    }
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the current session only', async () => {
    await t.db.delete(session);
    const [phone, laptop] = [new TestClient(ctx.app), new TestClient(ctx.app)];
    for (const client of [phone, laptop]) await login(client, { username: TEST_USERNAME, password: TEST_PASSWORD });
    expect(await t.db.select().from(session)).toHaveLength(2);

    const res = await phone.post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(phone.cookie(SESSION_COOKIE)).toBeUndefined();
    expect(await status(phone)).toEqual({ authenticated: false });
    expect(await status(laptop)).toEqual({ authenticated: true });
  });

  it('requires a session', async () => {
    expect((await new TestClient(ctx.app).post('/api/auth/logout')).status).toBe(401);
  });
});
