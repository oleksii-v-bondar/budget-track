import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appUser, loginAttempt, session } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { type SetupResult, setUpBudget, TEST_PASSWORD } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';
import { freshTotpCode, totpCode } from '../test/totp';
import { verifyPassword } from './passwords';
import { decryptSecret } from './secret-box';
import { SESSION_COOKIE } from './sessions';

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

const NEW_PASSWORD = 'an even better passphrase';

async function call(client: TestClient, path: string, body?: unknown) {
  const res = await client.post(path, body);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function signIn(ip: string, password = TEST_PASSWORD, secret = setup.totpSecret) {
  const client = new TestClient(ctx.app, ip);
  const res = await client.post('/api/auth/login', { password, totpCode: await freshTotpCode(secret, ctx.clock) });
  return { client, status: res.status };
}

/** An unused code from the current authenticator (the clock moves on one 30 s step). */
const code = () => freshTotpCode(setup.totpSecret, ctx.clock);

async function storedUser() {
  const [user] = await t.db.select().from(appUser);
  return user!;
}

const attemptsFrom = (ip: string) =>
  t.db.select({ success: loginAttempt.success }).from(loginAttempt).where(eq(loginAttempt.ip, ip));

const isSignedIn = (client: TestClient) =>
  client.get('/api/auth/status').then(async (r) => ((await r.json()) as { authenticated: boolean }).authenticated);

describe('security settings', () => {
  it('require a session', async () => {
    for (const path of ['/api/auth/logout-all', '/api/auth/password', '/api/auth/totp/secret', '/api/auth/totp', '/api/auth/recovery-codes']) {
      expect((await new TestClient(ctx.app).post(path, {})).status).toBe(401);
    }
  });
});

describe('routing', () => {
  it('leaves other /api/auth paths alone', async () => {
    expect((await new TestClient(ctx.app).get('/api/auth/nope')).status).toBe(404);
  });
});

describe('POST /api/auth/logout-all', () => {
  it('ends every session, including the current one', async () => {
    const { client: laptop } = await signIn('198.51.100.1');
    expect((await call(ctx.client, '/api/auth/logout-all')).status).toBe(200);
    expect(ctx.client.cookie(SESSION_COOKIE)).toBeUndefined();
    expect(await t.db.select().from(session)).toEqual([]);
    expect((await laptop.get('/api/auth/status').then((r) => r.json()))).toEqual({ setupRequired: false, authenticated: false });
  });
});

describe('POST /api/auth/password', () => {
  it('changes the password and signs out every other session', async () => {
    const { client: laptop } = await signIn('198.51.100.1');
    const res = await call(ctx.client, '/api/auth/password', {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      totpCode: await code(),
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const [user] = await t.db.select().from(appUser);
    expect(await verifyPassword(user!.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await laptop.get('/api/auth/status').then((r) => r.json())).toMatchObject({ authenticated: false });
    expect(await ctx.client.get('/api/auth/status').then((r) => r.json())).toMatchObject({ authenticated: true });
    expect((await signIn('198.51.100.2', NEW_PASSWORD)).status).toBe(200);
    expect((await signIn('198.51.100.3', TEST_PASSWORD)).status).toBe(401);
  });

  it('refuses without the current password and code', async () => {
    const { client: laptop } = await signIn('198.51.100.1');
    const res = await call(ctx.client, '/api/auth/password', {
      currentPassword: 'not it',
      newPassword: NEW_PASSWORD,
      totpCode: await code(),
    });
    expect(res).toEqual({
      status: 422,
      body: { code: 'invalid_credentials', message: 'Your current password or code is wrong.' },
    });
    const wrongCode = await call(ctx.client, '/api/auth/password', {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      totpCode: '000000',
    });
    expect(wrongCode.status).toBe(422);
    expect(await verifyPassword((await storedUser()).passwordHash, TEST_PASSWORD)).toBe(true);
    expect(await isSignedIn(laptop)).toBe(true);
    expect(await isSignedIn(ctx.client)).toBe(true);
  });

  it('refuses an authenticator code that was already used', async () => {
    const totpCode = await code();
    expect((await call(ctx.client, '/api/auth/recovery-codes', { currentPassword: TEST_PASSWORD, totpCode })).status).toBe(200);
    const res = await call(ctx.client, '/api/auth/password', {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      totpCode,
    });
    expect(res).toEqual({
      status: 422,
      body: { code: 'invalid_credentials', message: 'Your current password or code is wrong.' },
    });
    expect(await verifyPassword((await storedUser()).passwordHash, TEST_PASSWORD)).toBe(true);
  });

  it('limits re-authentication to 5 attempts per minute per IP', async () => {
    // One code for every attempt, so the clock stays inside the minute (a failed attempt doesn't use the code up).
    const totpCode = await code();
    for (let i = 0; i < 5; i++) {
      const res = await call(ctx.client, '/api/auth/password', {
        currentPassword: 'guess',
        newPassword: NEW_PASSWORD,
        totpCode,
      });
      expect(res.status).toBe(422);
    }
    const res = await call(ctx.client, '/api/auth/password', {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      totpCode,
    });
    expect(res).toEqual({
      status: 429,
      body: { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' },
    });
    expect(await verifyPassword((await storedUser()).passwordHash, TEST_PASSWORD)).toBe(true);
  });
});

describe('authenticator rotation', () => {
  async function newSecret() {
    const { body } = await call(ctx.client, '/api/auth/totp/secret');
    return body.secret as string;
  }

  it('switches to a new secret once a code from it is confirmed', async () => {
    const { body } = await call(ctx.client, '/api/auth/totp/secret');
    const newSecret = body.secret as string;
    expect(newSecret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.uri).toContain(newSecret);

    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      currentTotpCode: await code(),
      totpSecret: newSecret,
      totpCode: await totpCode(newSecret, ctx.clock.now()),
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const [user] = await t.db.select().from(appUser);
    expect(decryptSecret(user!.totpSecretEnc, ctx.config.encryptionKey)).toBe(newSecret);
    expect((await signIn('198.51.100.3', TEST_PASSWORD, newSecret)).status).toBe(200);
    expect((await signIn('198.51.100.4', TEST_PASSWORD, setup.totpSecret)).status).toBe(401);
  });

  it("uses up the new authenticator's confirmation code", async () => {
    const secret = await newSecret();
    const confirmation = await totpCode(secret, ctx.clock.now());
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      recoveryCode: setup.recoveryCodes[4],
      totpSecret: secret,
      totpCode: confirmation,
    });
    expect(res.status).toBe(200);
    const login = await new TestClient(ctx.app, '198.51.100.9').post('/api/auth/login', {
      password: TEST_PASSWORD,
      totpCode: confirmation,
    });
    expect(login.status).toBe(401);
  });

  it('keeps the old secret if the confirmation code is wrong', async () => {
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      currentTotpCode: await code(),
      totpSecret: await newSecret(),
      totpCode: '000000',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_totp_code');
    const [user] = await t.db.select().from(appUser);
    expect(decryptSecret(user!.totpSecretEnc, ctx.config.encryptionKey)).toBe(setup.totpSecret);
    // The new code is checked before re-authenticating, so this is not a sign-in attempt at all.
    expect(await attemptsFrom(ctx.client.ip)).toEqual([]);
  });

  it('keeps the recovery code if the confirmation code is wrong', async () => {
    const before = (await storedUser()).recoveryCodeHashes;
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      recoveryCode: setup.recoveryCodes[1],
      totpSecret: await newSecret(),
      totpCode: '000000',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_totp_code');
    const user = await storedUser();
    expect(user.recoveryCodeHashes).toHaveLength(10);
    expect(user.recoveryCodeHashes).toEqual(before);
    expect(decryptSecret(user.totpSecretEnc, ctx.config.encryptionKey)).toBe(setup.totpSecret);
    expect(await attemptsFrom(ctx.client.ip)).toEqual([]);
  });

  it('keeps a valid recovery code if the current password is wrong', async () => {
    const secret = await newSecret();
    const recoveryCode = setup.recoveryCodes[3]!;
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: 'wrong',
      recoveryCode,
      totpSecret: secret,
      totpCode: await totpCode(secret, ctx.clock.now()),
    });
    expect(res).toEqual({
      status: 422,
      body: { code: 'invalid_credentials', message: 'Your current password or code is wrong.' },
    });
    expect((await storedUser()).recoveryCodeHashes).toHaveLength(setup.recoveryCodes.length);
    const later = await new TestClient(ctx.app, '198.51.100.8').post('/api/auth/login', {
      password: TEST_PASSWORD,
      recoveryCode,
    });
    expect(later.status).toBe(200);
  });

  it('refuses a wrong current password', async () => {
    const secret = await newSecret();
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: 'not it',
      currentTotpCode: await code(),
      totpSecret: secret,
      totpCode: await totpCode(secret, ctx.clock.now()),
    });
    expect(res).toEqual({
      status: 422,
      body: { code: 'invalid_credentials', message: 'Your current password or code is wrong.' },
    });
    expect(decryptSecret((await storedUser()).totpSecretEnc, ctx.config.encryptionKey)).toBe(setup.totpSecret);
  });

  it('requires the current authenticator code or a recovery code, not both', async () => {
    const secret = await newSecret();
    const base = { currentPassword: TEST_PASSWORD, totpSecret: secret, totpCode: await totpCode(secret, ctx.clock.now()) };
    const both = { ...base, currentTotpCode: await code(), recoveryCode: setup.recoveryCodes[0] };
    for (const body of [base, both]) {
      const res = await call(ctx.client, '/api/auth/totp', body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'validation',
        formErrors: ['Enter either a code from your current authenticator app or a recovery code.'],
      });
    }
    expect(decryptSecret((await storedUser()).totpSecretEnc, ctx.config.encryptionKey)).toBe(setup.totpSecret);
  });

  it('refuses a wrong current code', async () => {
    const secret = await newSecret();
    const wrongCodes = [{ currentTotpCode: '000000' }, { recoveryCode: 'AAAA-AAAA-AAAA' }];
    for (const factor of wrongCodes) {
      const res = await call(ctx.client, '/api/auth/totp', {
        currentPassword: TEST_PASSWORD,
        ...factor,
        totpSecret: secret,
        totpCode: await totpCode(secret, ctx.clock.now()),
      });
      expect(res).toEqual({
        status: 422,
        body: { code: 'invalid_credentials', message: 'Your current password or code is wrong.' },
      });
    }
    expect(decryptSecret((await storedUser()).totpSecretEnc, ctx.config.encryptionKey)).toBe(setup.totpSecret);
  });

  it('accepts a recovery code instead of the lost authenticator, and uses it up', async () => {
    const secret = await newSecret();
    const recoveryCode = setup.recoveryCodes[2]!;
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      recoveryCode,
      totpSecret: secret,
      totpCode: await totpCode(secret, ctx.clock.now()),
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const user = await storedUser();
    expect(decryptSecret(user.totpSecretEnc, ctx.config.encryptionKey)).toBe(secret);
    expect(user.recoveryCodeHashes).toHaveLength(setup.recoveryCodes.length - 1);
    const reused = await new TestClient(ctx.app, '198.51.100.7').post('/api/auth/login', {
      password: TEST_PASSWORD,
      recoveryCode,
    });
    expect(reused.status).toBe(401);
  });

  it('signs out every other session', async () => {
    const { client: laptop } = await signIn('198.51.100.1');
    const secret = await newSecret();
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      currentTotpCode: await code(),
      totpSecret: secret,
      totpCode: await totpCode(secret, ctx.clock.now()),
    });
    expect(res.status).toBe(200);
    expect(await isSignedIn(laptop)).toBe(false);
    expect(await isSignedIn(ctx.client)).toBe(true);
  });
});

describe('POST /api/auth/recovery-codes', () => {
  it('replaces all recovery codes', async () => {
    const res = await call(ctx.client, '/api/auth/recovery-codes', { currentPassword: TEST_PASSWORD, totpCode: await code() });
    expect(res.status).toBe(200);
    const fresh = res.body.recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    const oldCode = await new TestClient(ctx.app, '198.51.100.5').post('/api/auth/login', {
      password: TEST_PASSWORD,
      recoveryCode: setup.recoveryCodes[0],
    });
    expect(oldCode.status).toBe(401);
    const newCode = await new TestClient(ctx.app, '198.51.100.6').post('/api/auth/login', {
      password: TEST_PASSWORD,
      recoveryCode: fresh[0],
    });
    expect(newCode.status).toBe(200);
  });

  it('keeps the old codes when the password or code is wrong', async () => {
    const wrongPassword = await call(ctx.client, '/api/auth/recovery-codes', { currentPassword: 'not it', totpCode: await code() });
    const wrongCode = await call(ctx.client, '/api/auth/recovery-codes', { currentPassword: TEST_PASSWORD, totpCode: '000000' });
    for (const res of [wrongPassword, wrongCode]) {
      expect(res).toEqual({
        status: 422,
        body: { code: 'invalid_credentials', message: 'Your current password or code is wrong.' },
      });
    }
    const oldCode = await new TestClient(ctx.app, '198.51.100.5').post('/api/auth/login', {
      password: TEST_PASSWORD,
      recoveryCode: setup.recoveryCodes[0],
    });
    expect(oldCode.status).toBe(200);
  });
});
