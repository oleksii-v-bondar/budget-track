import { asc, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appUser, category, categoryGroup } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { enableAuthenticator, setUpBudget, TEST_PASSWORD } from '../test/auth';
import { TEST_SETUP_TOKEN } from '../test/config';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';
import { verifyPassword } from './passwords';
import { SESSION_COOKIE } from './sessions';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db, { now: '2026-11-20T10:00:00Z' });
});
afterEach(async () => {
  await t.drop();
});

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function setupBody(overrides: Record<string, string> = {}) {
  return { setupToken: TEST_SETUP_TOKEN, password: TEST_PASSWORD, ...overrides };
}

const ALREADY_SETUP = {
  status: 409,
  body: { code: 'already_setup', message: 'This budget is already set up. Sign in instead.' },
};

describe('GET /api/auth/status', () => {
  it('asks for setup on a fresh install', async () => {
    expect(await json(await ctx.client.get('/api/auth/status'))).toEqual({
      status: 200,
      body: { setupRequired: true, authenticated: false, authenticatorEnabled: false },
    });
  });

  it('says whether sign-in asks for an authenticator code, also to a signed-out visitor', async () => {
    await setUpBudget(ctx);
    const visitor = new TestClient(ctx.app, '198.51.100.9');
    expect(await (await visitor.get('/api/auth/status')).json()).toEqual({
      setupRequired: false,
      authenticated: false,
      authenticatorEnabled: false,
    });
    await enableAuthenticator(ctx);
    expect(await (await visitor.get('/api/auth/status')).json()).toEqual({
      setupRequired: false,
      authenticated: false,
      authenticatorEnabled: true,
    });
    expect(await (await ctx.client.get('/api/auth/status')).json()).toEqual({
      setupRequired: false,
      authenticated: true,
      authenticatorEnabled: true,
    });
  });

  it("refreshes a signed-in client's cookie and clears a stale one", async () => {
    await setUpBudget(ctx);
    ctx.clock.advance(20 * 24 * 60 * 60 * 1000);
    const live = await ctx.client.get('/api/auth/status');
    expect(await live.json()).toEqual({ setupRequired: false, authenticated: true, authenticatorEnabled: false });
    expect(live.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=[\\w-]{43}; Max-Age=2592000;`));

    const stale = await ctx.client.get('/api/auth/status', { cookie: `${SESSION_COOKIE}=no-such-session` });
    expect(await stale.json()).toEqual({ setupRequired: false, authenticated: false, authenticatorEnabled: false });
    expect(stale.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=; Max-Age=0`);
  });
});

describe('POST /api/auth/setup', () => {
  it('creates the user without an authenticator, seeds the budget and signs in', async () => {
    const res = await ctx.client.post('/api/auth/setup', setupBody());
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 201, body: { ok: true } });
    expect(ctx.client.cookie(SESSION_COOKIE)).toBeDefined();
    expect(await json(await ctx.client.get('/api/auth/status'))).toEqual({
      status: 200,
      body: { setupRequired: false, authenticated: true, authenticatorEnabled: false },
    });

    const [user] = await t.db.select().from(appUser);
    expect(await verifyPassword(user!.passwordHash, TEST_PASSWORD)).toBe(true);
    expect(user).toMatchObject({ totpSecretEnc: null, recoveryCodeHashes: [], totpLastStep: null });
    expect(user!.budgetStartMonth).toBe('2026-11-01');

    const groups = await t.db.select().from(categoryGroup).orderBy(asc(categoryGroup.sortOrder));
    expect(groups.map((g) => [g.name, g.kind, g.hidden])).toEqual([
      ['Internal', 'internal', true],
      ['Credit Card Payments', 'cc_payments', false],
      ['Debt Payments', 'debt_payments', false],
    ]);
    const system = await t.db.select().from(category).orderBy(asc(category.sortOrder));
    expect(system.map((c) => [c.name, c.systemKind, c.groupId, c.hidden])).toEqual([
      ['Ready to Assign', 'rta', groups[0]!.id, true],
      ['Uncategorized', 'uncategorized', groups[0]!.id, true],
    ]);
  });

  it('uses the configured time zone for the budget start month', async () => {
    const lateNewYearsEve = createTestApp(t.db, { now: '2026-12-31T23:30:00Z' });
    await setUpBudget(lateNewYearsEve);
    const [user] = await t.db.select().from(appUser);
    expect(user!.budgetStartMonth).toBe('2027-01-01');
  });

  it('no longer offers an authenticator: that is turned on in Settings', async () => {
    const res = await ctx.client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN });
    expect(res.status).toBe(404);
  });

  it('requires the setup token from the environment without creating anything', async () => {
    const res = await json(await ctx.client.post('/api/auth/setup', setupBody({ setupToken: 'guess' })));
    expect(res).toEqual({
      status: 403,
      body: { code: 'invalid_setup_token', message: 'That setup token is not correct.' },
    });
    expect(await t.db.select().from(appUser)).toEqual([]);
  });

  it('limits setup-token guesses like sign-ins: 5 per minute per IP', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await ctx.client.post('/api/auth/setup', setupBody({ setupToken: `guess ${i}` }))).status).toBe(403);
    }
    const limited = await ctx.client.post('/api/auth/setup', setupBody());
    expect(await json(limited)).toEqual({
      status: 429,
      body: { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' },
    });
    expect(await t.db.select().from(appUser)).toEqual([]);
    ctx.clock.advance(60_001);
    expect((await ctx.client.post('/api/auth/setup', setupBody())).status).toBe(201);
  });

  it('validates the request body', async () => {
    const res = await json(
      await ctx.client.post('/api/auth/setup', setupBody({ password: 'too short' })),
    );
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toEqual({ password: ['Use at least 12 characters.'] });
  });

  it("ends the streak of failed attempts, so wrong setup tokens before it don't lock out the first sign-ins", async () => {
    // Nine wrong tokens (from different addresses: 5 attempts per minute per IP), one short of the lockout.
    for (let i = 0; i < 9; i++) {
      const guesser = new TestClient(ctx.app, `198.51.100.${40 + i}`);
      expect((await guesser.post('/api/auth/setup', setupBody({ setupToken: `guess ${i}` }))).status).toBe(403);
    }
    await setUpBudget(ctx);
    const owner = new TestClient(ctx.app, '198.51.100.60');
    const signIn = async (password: string) => (await owner.post('/api/auth/login', { password })).status;
    expect(await signIn('not the password')).toBe(401);
    // Without setup's success, that was the tenth failure in a row: sign-in would be locked for 15 minutes.
    expect(await signIn(TEST_PASSWORD)).toBe(200);
  });

  it('can run only once', async () => {
    await setUpBudget(ctx);
    const stranger = new TestClient(ctx.app, '198.51.100.9');
    const again = await json(await stranger.post('/api/auth/setup', { setupToken: 'guess', password: 'any password at all' }));
    expect(again).toEqual(ALREADY_SETUP);
    expect(await json(await stranger.get('/api/auth/status'))).toEqual({
      status: 200,
      body: { setupRequired: false, authenticated: false, authenticatorEnabled: false },
    });
  });

  it('refuses a second setup even with the correct token', async () => {
    await setUpBudget(ctx);
    const stranger = new TestClient(ctx.app, '198.51.100.9');
    expect(await json(await stranger.post('/api/auth/setup', setupBody()))).toEqual(ALREADY_SETUP);
    expect(stranger.cookie(SESSION_COOKIE)).toBeUndefined();
    expect(await t.db.select().from(appUser)).toHaveLength(1);
  });

  it('lets only one of two racing setups win', async () => {
    const body = setupBody();
    const clients = [new TestClient(ctx.app, '198.51.100.1'), new TestClient(ctx.app, '198.51.100.2')];
    const results = await Promise.all(clients.map(async (client) => json(await client.post('/api/auth/setup', body))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)).toEqual(ALREADY_SETUP);
    expect(await t.db.select().from(appUser)).toHaveLength(1);
  });

  it('rolls setup back if the session cannot be created, so it can simply be run again', async () => {
    await t.db.execute(sql`ALTER TABLE "session" ADD CONSTRAINT reject_sessions CHECK (false)`);
    const res = await ctx.client.post('/api/auth/setup', setupBody());
    expect(res.status).toBe(500);
    expect(ctx.client.cookie(SESSION_COOKIE)).toBeUndefined();
    expect(await t.db.select().from(appUser)).toEqual([]);
    expect(await t.db.select().from(categoryGroup)).toEqual([]);
  });
});
