import { asc, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appUser, category, categoryGroup } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget, TEST_PASSWORD } from '../test/auth';
import { TEST_SETUP_TOKEN } from '../test/config';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';
import { totpCode } from '../test/totp';
import { verifyPassword } from './passwords';
import { consumeRecoveryCode } from './recovery-codes';
import { decryptSecret } from './secret-box';
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

async function newTotpSecret(client: TestClient): Promise<string> {
  const res = await client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN });
  return ((await res.json()) as { secret: string }).secret;
}

async function setupBody(secret: string, overrides: Record<string, string> = {}) {
  return {
    setupToken: TEST_SETUP_TOKEN,
    password: TEST_PASSWORD,
    totpSecret: secret,
    totpCode: await totpCode(secret, ctx.clock.now()),
    ...overrides,
  };
}

const ALREADY_SETUP = {
  status: 409,
  body: { code: 'already_setup', message: 'This budget is already set up. Sign in instead.' },
};

describe('GET /api/auth/status', () => {
  it('asks for setup on a fresh install', async () => {
    expect(await json(await ctx.client.get('/api/auth/status'))).toEqual({
      status: 200,
      body: { setupRequired: true, authenticated: false },
    });
  });

  it("refreshes a signed-in client's cookie and clears a stale one", async () => {
    await setUpBudget(ctx);
    ctx.clock.advance(20 * 24 * 60 * 60 * 1000);
    const live = await ctx.client.get('/api/auth/status');
    expect(await live.json()).toEqual({ setupRequired: false, authenticated: true });
    expect(live.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=[\\w-]{43}; Max-Age=2592000;`));

    const stale = await ctx.client.get('/api/auth/status', { cookie: `${SESSION_COOKIE}=no-such-session` });
    expect(await stale.json()).toEqual({ setupRequired: false, authenticated: false });
    expect(stale.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=; Max-Age=0`);
  });
});

describe('POST /api/auth/setup/totp', () => {
  it('requires the setup token from the environment', async () => {
    const res = await json(await ctx.client.post('/api/auth/setup/totp', { setupToken: 'guess' }));
    expect(res).toEqual({ status: 403, body: { code: 'invalid_setup_token', message: 'That setup token is not correct.' } });
  });

  it('limits setup-token guesses like sign-ins: 5 per minute per IP', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await ctx.client.post('/api/auth/setup/totp', { setupToken: `guess ${i}` })).status).toBe(403);
    }
    const limited = await ctx.client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN });
    expect(await json(limited)).toEqual({
      status: 429,
      body: { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' },
    });
    expect((await new TestClient(ctx.app, '198.51.100.30').post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN })).status).toBe(200);
    ctx.clock.advance(60_001);
    expect((await ctx.client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN })).status).toBe(200);
  });

  it('returns a new authenticator secret and its otpauth URI', async () => {
    const res = await json(await ctx.client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN }));
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body.uri).toContain(`secret=${String(res.body.secret)}`);
  });
});

describe('POST /api/auth/setup', () => {
  it('creates the user, seeds the budget, signs in and returns ten recovery codes', async () => {
    const { totpSecret, recoveryCodes } = await setUpBudget(ctx);
    expect(recoveryCodes).toHaveLength(10);
    expect(ctx.client.cookie(SESSION_COOKIE)).toBeDefined();
    expect(await json(await ctx.client.get('/api/auth/status'))).toEqual({
      status: 200,
      body: { setupRequired: false, authenticated: true },
    });

    const [user] = await t.db.select().from(appUser);
    expect(await verifyPassword(user!.passwordHash, TEST_PASSWORD)).toBe(true);
    expect(decryptSecret(user!.totpSecretEnc, ctx.config.encryptionKey)).toBe(totpSecret);
    expect(user!.recoveryCodeHashes).toHaveLength(10);
    expect(await consumeRecoveryCode(user!.recoveryCodeHashes, recoveryCodes[0]!)).not.toBeNull();
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

  it('rejects a wrong authenticator code without creating anything', async () => {
    const { secret } = (await (
      await ctx.client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN })
    ).json()) as { secret: string };
    const later = new Date(ctx.clock.now().getTime() + 5 * 60_000);
    const res = await json(
      await ctx.client.post('/api/auth/setup', {
        setupToken: TEST_SETUP_TOKEN,
        password: TEST_PASSWORD,
        totpSecret: secret,
        totpCode: await totpCode(secret, later),
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_totp_code');
    expect(await t.db.select().from(appUser)).toEqual([]);
  });

  it('requires the setup token from the environment without creating anything', async () => {
    const secret = await newTotpSecret(ctx.client);
    const res = await json(await ctx.client.post('/api/auth/setup', await setupBody(secret, { setupToken: 'guess' })));
    expect(res).toEqual({
      status: 403,
      body: { code: 'invalid_setup_token', message: 'That setup token is not correct.' },
    });
    expect(await t.db.select().from(appUser)).toEqual([]);
  });

  it('validates the request body', async () => {
    const res = await json(
      await ctx.client.post('/api/auth/setup', {
        setupToken: TEST_SETUP_TOKEN,
        password: 'too short',
        totpSecret: 'A'.repeat(32),
        totpCode: '123456',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toEqual({ password: ['Use at least 12 characters.'] });
  });

  it('can run only once', async () => {
    await setUpBudget(ctx);
    const stranger = new TestClient(ctx.app, '198.51.100.9');
    const again = await json(await stranger.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN }));
    expect(again).toEqual(ALREADY_SETUP);
    expect(await json(await stranger.get('/api/auth/status'))).toEqual({
      status: 200,
      body: { setupRequired: false, authenticated: false },
    });
  });

  it('refuses a second setup even with the correct token', async () => {
    const { totpSecret } = await setUpBudget(ctx);
    const stranger = new TestClient(ctx.app, '198.51.100.9');
    expect(await json(await stranger.post('/api/auth/setup', await setupBody(totpSecret)))).toEqual(ALREADY_SETUP);
    expect(stranger.cookie(SESSION_COOKIE)).toBeUndefined();
    expect(await t.db.select().from(appUser)).toHaveLength(1);
  });

  it('lets only one of two racing setups win', async () => {
    const body = await setupBody(await newTotpSecret(ctx.client));
    const clients = [new TestClient(ctx.app, '198.51.100.1'), new TestClient(ctx.app, '198.51.100.2')];
    const results = await Promise.all(clients.map(async (client) => json(await client.post('/api/auth/setup', body))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)).toEqual(ALREADY_SETUP);
    expect(await t.db.select().from(appUser)).toHaveLength(1);
  });

  it('rolls setup back if the session cannot be created, so no owner is left without recovery codes', async () => {
    await t.db.execute(sql`ALTER TABLE "session" ADD CONSTRAINT reject_sessions CHECK (false)`);
    const res = await ctx.client.post('/api/auth/setup', await setupBody(await newTotpSecret(ctx.client)));
    expect(res.status).toBe(500);
    expect(ctx.client.cookie(SESSION_COOKIE)).toBeUndefined();
    expect(await t.db.select().from(appUser)).toEqual([]);
    expect(await t.db.select().from(categoryGroup)).toEqual([]);
  });
});
