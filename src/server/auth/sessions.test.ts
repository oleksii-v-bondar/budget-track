import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../db/schema';
import type { AppEnv } from '../http/env';
import { errorHandler } from '../http/errors';
import { createLogger } from '../logger';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { FakeClock } from '../test/fake-clock';
import { TestClient } from '../test/http-client';
import {
  createSession,
  deleteAllSessions,
  deleteSession,
  findSession,
  requireSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  setSessionCookie,
} from './sessions';

const DAY = 24 * 60 * 60 * 1000;
let t: TestDatabase;
let clock: FakeClock;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.db.delete(session);
  clock = new FakeClock('2026-11-20T10:00:00Z');
});

describe('session store', () => {
  it('stores only a hash of the random token', async () => {
    const { token, session: created } = await createSession(t.db, clock.now(), 'Safari');
    expect(token).toMatch(/^[\w-]{43}$/);
    const [row] = await t.db.select().from(session);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.tokenHash).not.toContain(token);
    expect(created.expiresAt).toEqual(new Date(clock.now().getTime() + SESSION_TTL_MS));
  });

  it('slides the expiry forward on use and forgets expired sessions', async () => {
    const { token } = await createSession(t.db, clock.now(), undefined);
    clock.advance(10 * DAY);
    const found = await findSession(t.db, token, clock.now());
    expect(found?.expiresAt).toEqual(new Date(clock.now().getTime() + SESSION_TTL_MS));
    clock.advance(30 * DAY);
    expect(await findSession(t.db, token, clock.now())).toBeNull();
    expect(await findSession(t.db, 'unknown-token', clock.now())).toBeNull();
  });

  it('deletes one session, or all but one', async () => {
    const a = await createSession(t.db, clock.now(), undefined);
    const b = await createSession(t.db, clock.now(), undefined);
    const c = await createSession(t.db, clock.now(), undefined);
    await deleteSession(t.db, a.session.id);
    expect(await findSession(t.db, a.token, clock.now())).toBeNull();
    await deleteAllSessions(t.db, { exceptId: b.session.id });
    expect(await findSession(t.db, b.token, clock.now())).not.toBeNull();
    expect(await findSession(t.db, c.token, clock.now())).toBeNull();
    await deleteAllSessions(t.db);
    expect(await t.db.select().from(session)).toEqual([]);
  });
});

describe('requireSession', () => {
  function protectedApp() {
    const deps = { db: t.db, clock, config: { cookieSecure: true } };
    const app = new Hono<AppEnv>()
      .use(requestId())
      .use(async (c, next) => {
        c.set('logger', createLogger('silent'));
        await next();
      })
      .post('/login', async (c) => {
        const { token } = await createSession(t.db, clock.now(), undefined);
        setSessionCookie(c, token, true);
        return c.json({ ok: true });
      })
      .get('/private', requireSession(deps), (c) => c.json({ sessionId: c.var.session.id }));
    app.onError(errorHandler);
    return new TestClient(app);
  }

  it('rejects requests without a valid session', async () => {
    const client = protectedApp();
    const res = await client.get('/private');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'unauthorized', message: 'Please sign in.' });
  });

  it('admits a signed-in client and refreshes its cookie', async () => {
    const client = protectedApp();
    await client.post('/login');
    expect(client.cookie(SESSION_COOKIE)).toBeDefined();
    const res = await client.get('/private');
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('Max-Age=2592000');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('turns a client away once its session has expired', async () => {
    const client = protectedApp();
    await client.post('/login');
    clock.advance(31 * DAY);
    expect((await client.get('/private')).status).toBe(401);
  });
});
