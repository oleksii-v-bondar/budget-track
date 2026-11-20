import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appUser, category, categoryGroup } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget, TEST_PASSWORD } from '../test/auth';
import { TEST_SETUP_TOKEN } from '../test/config';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';
import { totpCode } from '../test/totp';
import { verifyPassword } from './passwords';
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

describe('GET /api/auth/status', () => {
  it('asks for setup on a fresh install', async () => {
    expect(await json(await ctx.client.get('/api/auth/status'))).toEqual({
      status: 200,
      body: { setupRequired: true, authenticated: false },
    });
  });
});

describe('POST /api/auth/setup/totp', () => {
  it('requires the setup token from the environment', async () => {
    const res = await json(await ctx.client.post('/api/auth/setup/totp', { setupToken: 'guess' }));
    expect(res).toEqual({ status: 403, body: { code: 'invalid_setup_token', message: 'That setup token is not correct.' } });
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
    expect(user!.budgetStartMonth).toBe('2026-11-01');

    const groups = await t.db.select().from(categoryGroup).orderBy(asc(categoryGroup.sortOrder));
    expect(groups.map((g) => [g.name, g.kind, g.hidden])).toEqual([
      ['Internal', 'internal', true],
      ['Credit Card Payments', 'cc_payments', false],
      ['Debt Payments', 'debt_payments', false],
    ]);
    const system = await t.db.select().from(category).orderBy(asc(category.sortOrder));
    expect(system.map((c) => [c.name, c.systemKind, c.groupId])).toEqual([
      ['Ready to Assign', 'rta', groups[0]!.id],
      ['Uncategorized', 'uncategorized', groups[0]!.id],
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
    expect(again).toEqual({
      status: 409,
      body: { code: 'already_setup', message: 'This budget is already set up. Sign in instead.' },
    });
    expect(await json(await stranger.get('/api/auth/status'))).toEqual({
      status: 200,
      body: { setupRequired: false, authenticated: false },
    });
  });
});
