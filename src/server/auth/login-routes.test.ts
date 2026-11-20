import * as argon2 from '@node-rs/argon2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appUser, session } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { type SetupResult, setUpBudget, TEST_PASSWORD } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';
import { totpCode } from '../test/totp';
import { RECOVERY_CODE_COUNT } from './recovery-codes';
import { SESSION_COOKIE } from './sessions';

// Counts argon2 verifications so a test can check that sign-in does the same work for right and wrong passwords.
vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof argon2>();
  return { ...actual, verify: vi.fn(actual.verify) };
});

let t: TestDatabase;
let ctx: TestApp;
let setup: SetupResult;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db);
  setup = await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

const MINUTE = 60_000;

async function login(client: TestClient, body: Record<string, unknown>) {
  const res = await client.post('/api/auth/login', body);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function withCode(password = TEST_PASSWORD) {
  return { password, totpCode: await totpCode(setup.totpSecret, ctx.clock.now()) };
}

describe('POST /api/auth/login', () => {
  it('signs in with password and authenticator code', async () => {
    const client = new TestClient(ctx.app);
    expect(await login(client, await withCode())).toEqual({ status: 200, body: { recoveryCodesRemaining: 10 } });
    expect(client.cookie(SESSION_COOKIE)).toBeDefined();
    expect(await (await client.get('/api/auth/status')).json()).toEqual({ setupRequired: false, authenticated: true });
  });

  it('rejects a wrong password or code with the same message', async () => {
    const client = new TestClient(ctx.app);
    const wrongPassword = await login(client, await withCode('not my password'));
    const wrongCode = await login(client, { password: TEST_PASSWORD, totpCode: '000000' });
    for (const res of [wrongPassword, wrongCode]) {
      expect(res).toEqual({ status: 401, body: { code: 'invalid_credentials', message: 'Wrong password or code.' } });
    }
    expect(client.cookie(SESSION_COOKIE)).toBeUndefined();
  });

  it('accepts each recovery code once', async () => {
    const client = new TestClient(ctx.app);
    const code = setup.recoveryCodes[3]!;
    expect(await login(client, { password: TEST_PASSWORD, recoveryCode: code })).toEqual({
      status: 200,
      body: { recoveryCodesRemaining: 9 },
    });
    const [user] = await t.db.select().from(appUser);
    expect(user!.recoveryCodeHashes).toHaveLength(9);
    expect((await login(new TestClient(ctx.app), { password: TEST_PASSWORD, recoveryCode: code })).status).toBe(401);
  });

  it('does not burn a recovery code when the password is wrong', async () => {
    const code = setup.recoveryCodes[0]!;
    expect((await login(new TestClient(ctx.app), { password: 'wrong password', recoveryCode: code })).status).toBe(401);
    expect((await login(new TestClient(ctx.app), { password: TEST_PASSWORD, recoveryCode: code })).status).toBe(200);
  });

  it('checks every recovery code whether or not the password is right', async () => {
    const valid = setup.recoveryCodes[0]!;
    const unknown = 'AAAA-AAAA-AAAA';
    const attempts = [
      { password: 'wrong password', recoveryCode: valid, status: 401 },
      { password: 'wrong password', recoveryCode: unknown, status: 401 },
      { password: TEST_PASSWORD, recoveryCode: unknown, status: 401 },
      { password: TEST_PASSWORD, recoveryCode: valid, status: 200 },
    ];
    for (const { status, ...body } of attempts) {
      vi.mocked(argon2.verify).mockClear();
      expect((await login(new TestClient(ctx.app), body)).status).toBe(status);
      expect(argon2.verify).toHaveBeenCalledTimes(1 + RECOVERY_CODE_COUNT);
    }
  });

  it('lets only one of two simultaneous sign-ins use the same recovery code', async () => {
    const code = setup.recoveryCodes[5]!;
    const results = await Promise.all(
      ['198.51.100.10', '198.51.100.11'].map((ip) =>
        login(new TestClient(ctx.app, ip), { password: TEST_PASSWORD, recoveryCode: code }),
      ),
    );
    expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 401]);
    const [user] = await t.db.select().from(appUser);
    expect(user!.recoveryCodeHashes).toHaveLength(RECOVERY_CODE_COUNT - 1);
  });

  it('limits each IP to 5 attempts per minute', async () => {
    const attacker = new TestClient(ctx.app, '198.51.100.66');
    for (let i = 0; i < 5; i++) expect((await login(attacker, { password: 'guess', totpCode: '000000' })).status).toBe(401);
    expect(await login(attacker, await withCode())).toEqual({
      status: 429,
      body: { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' },
    });
    expect((await login(new TestClient(ctx.app, '198.51.100.67'), await withCode())).status).toBe(200);
    ctx.clock.advance(MINUTE + 1);
    expect((await login(attacker, await withCode())).status).toBe(200);
  });

  it('applies the per-IP limit to simultaneous attempts', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        login(new TestClient(ctx.app, '198.51.100.66'), { password: 'guess', totpCode: '000000' }),
      ),
    );
    expect(results.filter((res) => res.status === 401)).toHaveLength(5);
    expect(results.filter((res) => res.status === 429 && res.body.code === 'rate_limited')).toHaveLength(3);
  });

  it('locks sign-in for 15 minutes after 10 consecutive failures', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await login(new TestClient(ctx.app, `198.51.100.${i}`), { password: 'guess', totpCode: '000000' });
      expect(res.status).toBe(401);
    }
    const owner = new TestClient(ctx.app);
    expect(await login(owner, await withCode())).toEqual({
      status: 429,
      body: { code: 'locked', message: 'Too many failed sign-ins. Try again in 15 minutes.' },
    });
    ctx.clock.advance(15 * MINUTE);
    expect((await login(owner, await withCode())).status).toBe(200);
  });

  it('refuses sign-in before setup', async () => {
    const fresh = await createTestDatabase();
    try {
      const other = createTestApp(fresh.db);
      expect(await login(other.client, { password: TEST_PASSWORD, totpCode: '123456' })).toEqual({
        status: 409,
        body: { code: 'setup_required', message: 'Finish setting up the budget first.' },
      });
    } finally {
      await fresh.drop();
    }
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the current session only', async () => {
    const phone = new TestClient(ctx.app);
    await login(phone, await withCode());
    expect(await t.db.select().from(session)).toHaveLength(2); // setup's session + phone

    const res = await phone.post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(phone.cookie(SESSION_COOKIE)).toBeUndefined();
    expect(await (await phone.get('/api/auth/status')).json()).toEqual({ setupRequired: false, authenticated: false });
    expect(await (await ctx.client.get('/api/auth/status')).json()).toEqual({ setupRequired: false, authenticated: true });
  });

  it('requires a session', async () => {
    expect((await new TestClient(ctx.app).post('/api/auth/logout')).status).toBe(401);
  });
});
