import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appUser, loginAttempt, session } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { type Authenticator, enableAuthenticator, setUpBudget, TEST_PASSWORD } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';
import { freshTotpCode, TOTP_STEP_MS, totpCode } from '../test/totp';
import { verifyPassword } from './passwords';
import { consumeRecoveryCode } from './recovery-codes';
import { decryptSecret } from './secret-box';
import { SESSION_COOKIE } from './sessions';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db);
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

const NEW_PASSWORD = 'an even better passphrase';

async function call(client: TestClient, path: string, body?: unknown) {
  const res = await client.post(path, body);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Signs in a new client from `ip`; with `secret`, also sends an unused code from it (the clock moves on 30 s). */
async function signIn(ip: string, password = TEST_PASSWORD, secret?: string) {
  const client = new TestClient(ctx.app, ip);
  const factor = secret === undefined ? {} : { totpCode: await freshTotpCode(secret, ctx.clock) };
  const res = await client.post('/api/auth/login', { password, ...factor });
  return { client, status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function storedUser() {
  const [user] = await t.db.select().from(appUser);
  return user!;
}

async function storedSecret() {
  const { totpSecretEnc } = await storedUser();
  return totpSecretEnc === null ? null : decryptSecret(totpSecretEnc, ctx.config.encryptionKey);
}

async function newSecret() {
  const { body } = await call(ctx.client, '/api/auth/totp/secret');
  return body.secret as string;
}

const attemptsFrom = (ip: string) =>
  t.db.select({ success: loginAttempt.success }).from(loginAttempt).where(eq(loginAttempt.ip, ip));

const isSignedIn = (client: TestClient) =>
  client.get('/api/auth/status').then(async (r) => ((await r.json()) as { authenticated: boolean }).authenticated);

const authenticatorEnabled = () =>
  new TestClient(ctx.app, '198.51.100.99')
    .get('/api/auth/status')
    .then(async (r) => ((await r.json()) as { authenticatorEnabled: boolean }).authenticatorEnabled);

const WRONG_PASSWORD = { status: 422, body: { code: 'invalid_credentials', message: 'Your current password is wrong.' } };
const WRONG_PASSWORD_OR_CODE = {
  status: 422,
  body: { code: 'invalid_credentials', message: 'Your current password or code is wrong.' },
};
const CODE_REQUIRED = {
  status: 422,
  body: { code: 'code_required', message: 'Enter a code from your authenticator app or a recovery code.' },
};
const NO_AUTHENTICATOR = {
  status: 422,
  body: { code: 'no_authenticator', message: 'The authenticator app is off.' },
};

describe('security settings', () => {
  it('require a session', async () => {
    const paths = [
      '/api/auth/logout-all',
      '/api/auth/password',
      '/api/auth/totp/secret',
      '/api/auth/totp',
      '/api/auth/totp/disable',
      '/api/auth/recovery-codes',
    ];
    for (const path of paths) {
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
    expect(await isSignedIn(laptop)).toBe(false);
  });
});

describe('POST /api/auth/password without an authenticator', () => {
  it('changes the password with the current password only and signs out every other session', async () => {
    const { client: laptop } = await signIn('198.51.100.1');
    const res = await call(ctx.client, '/api/auth/password', { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(await verifyPassword((await storedUser()).passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await isSignedIn(laptop)).toBe(false);
    expect(await isSignedIn(ctx.client)).toBe(true);
    expect((await signIn('198.51.100.2', NEW_PASSWORD)).status).toBe(200);
    expect((await signIn('198.51.100.3', TEST_PASSWORD)).status).toBe(401);
  });

  it('ignores a code sent with the password', async () => {
    const res = await call(ctx.client, '/api/auth/password', {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      totpCode: '000000',
    });
    expect(res.status).toBe(200);
  });

  it('refuses a wrong current password, recording the attempt', async () => {
    const before = (await attemptsFrom(ctx.client.ip)).length;
    const res = await call(ctx.client, '/api/auth/password', { currentPassword: 'not it', newPassword: NEW_PASSWORD });
    expect(res).toEqual(WRONG_PASSWORD);
    expect(await verifyPassword((await storedUser()).passwordHash, TEST_PASSWORD)).toBe(true);
    expect(await attemptsFrom(ctx.client.ip)).toHaveLength(before + 1);
  });

  it('limits re-authentication to 5 attempts per minute per IP', async () => {
    // Past the minute of setup's own (successful) attempt from this IP.
    ctx.clock.advance(60_000);
    for (let i = 0; i < 5; i++) {
      const res = await call(ctx.client, '/api/auth/password', { currentPassword: 'guess', newPassword: NEW_PASSWORD });
      expect(res.status).toBe(422);
    }
    const res = await call(ctx.client, '/api/auth/password', { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res).toEqual({
      status: 429,
      body: { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' },
    });
    expect(await verifyPassword((await storedUser()).passwordHash, TEST_PASSWORD)).toBe(true);
  });
});

describe('POST /api/auth/password with an authenticator', () => {
  let setup: Authenticator;
  beforeEach(async () => {
    setup = await enableAuthenticator(ctx);
  });
  /** An unused code from the current authenticator (the clock moves on one 30 s step). */
  const code = () => freshTotpCode(setup.totpSecret, ctx.clock);

  it('changes the password with the current password and code', async () => {
    const res = await call(ctx.client, '/api/auth/password', {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      totpCode: await code(),
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(await verifyPassword((await storedUser()).passwordHash, NEW_PASSWORD)).toBe(true);
    expect((await signIn('198.51.100.2', NEW_PASSWORD, setup.totpSecret)).status).toBe(200);
  });

  it('asks for the code when only the password is sent, without counting an attempt', async () => {
    const before = await attemptsFrom(ctx.client.ip);
    const res = await call(ctx.client, '/api/auth/password', { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res).toEqual(CODE_REQUIRED);
    expect(await attemptsFrom(ctx.client.ip)).toEqual(before);
    expect(await verifyPassword((await storedUser()).passwordHash, TEST_PASSWORD)).toBe(true);
  });

  it('refuses a wrong current password or code', async () => {
    const { client: laptop } = await signIn('198.51.100.1', TEST_PASSWORD, setup.totpSecret);
    const wrongPassword = await call(ctx.client, '/api/auth/password', {
      currentPassword: 'not it',
      newPassword: NEW_PASSWORD,
      totpCode: await code(),
    });
    const wrongCode = await call(ctx.client, '/api/auth/password', {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      totpCode: '000000',
    });
    for (const res of [wrongPassword, wrongCode]) expect(res).toEqual(WRONG_PASSWORD_OR_CODE);
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
    expect(res).toEqual(WRONG_PASSWORD_OR_CODE);
    expect(await verifyPassword((await storedUser()).passwordHash, TEST_PASSWORD)).toBe(true);
  });
});

describe('turning the authenticator on', () => {
  it('stores the new secret, returns ten recovery codes once, and from then on sign-in needs a code', async () => {
    const { body } = await call(ctx.client, '/api/auth/totp/secret');
    const secret = body.secret as string;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.uri).toContain(secret);
    expect(await storedSecret()).toBeNull();

    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      totpSecret: secret,
      totpCode: await totpCode(secret, ctx.clock.now()),
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const recoveryCodes = res.body.recoveryCodes as string[];
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    expect(await storedSecret()).toBe(secret);
    const user = await storedUser();
    expect(user.recoveryCodeHashes).toHaveLength(10);
    expect(await consumeRecoveryCode(user.recoveryCodeHashes, recoveryCodes[0]!)).not.toBeNull();
    expect(await authenticatorEnabled()).toBe(true);

    expect(await signIn('198.51.100.1')).toMatchObject({ status: 422, body: { code: 'code_required' } });
    expect(await signIn('198.51.100.2', TEST_PASSWORD, secret)).toMatchObject({
      status: 200,
      body: { authenticatorEnabled: true, recoveryCodesRemaining: 10 },
    });
  });

  it('ignores a current code sent while no authenticator is on', async () => {
    const secret = await newSecret();
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      currentTotpCode: '000000',
      totpSecret: secret,
      totpCode: await totpCode(secret, ctx.clock.now()),
    });
    expect(res.status).toBe(200);
    expect(await storedSecret()).toBe(secret);
  });

  it('uses up the confirmation code', async () => {
    const secret = await newSecret();
    const confirmation = await totpCode(secret, ctx.clock.now());
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
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

  it('signs out every other session', async () => {
    const { client: laptop } = await signIn('198.51.100.1');
    await enableAuthenticator(ctx);
    expect(await isSignedIn(laptop)).toBe(false);
    expect(await isSignedIn(ctx.client)).toBe(true);
  });

  it('refuses a wrong password and leaves the authenticator off', async () => {
    const secret = await newSecret();
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: 'not it',
      totpSecret: secret,
      totpCode: await totpCode(secret, ctx.clock.now()),
    });
    expect(res).toEqual(WRONG_PASSWORD);
    expect(await storedUser()).toMatchObject({ totpSecretEnc: null, recoveryCodeHashes: [], totpLastStep: null });
  });

  it('refuses a wrong confirmation code without counting a sign-in attempt', async () => {
    const attempts = await attemptsFrom(ctx.client.ip);
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      totpSecret: await newSecret(),
      totpCode: '000000',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_totp_code');
    expect(await storedSecret()).toBeNull();
    expect(await attemptsFrom(ctx.client.ip)).toEqual(attempts);
  });
});

describe('replacing the authenticator', () => {
  let setup: Authenticator;
  beforeEach(async () => {
    setup = await enableAuthenticator(ctx);
  });
  /** An unused code from the current authenticator (the clock moves on one 30 s step). */
  const code = () => freshTotpCode(setup.totpSecret, ctx.clock);

  it('switches to a new secret once a code from it is confirmed, keeping the recovery codes', async () => {
    const hashes = (await storedUser()).recoveryCodeHashes;
    const secret = await newSecret();
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      currentTotpCode: await code(),
      totpSecret: secret,
      totpCode: await totpCode(secret, ctx.clock.now()),
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(await storedSecret()).toBe(secret);
    expect((await storedUser()).recoveryCodeHashes).toEqual(hashes);
    expect((await signIn('198.51.100.3', TEST_PASSWORD, secret)).status).toBe(200);
    expect((await signIn('198.51.100.4', TEST_PASSWORD, setup.totpSecret)).status).toBe(401);
  });

  it("uses up the new authenticator's confirmation code", async () => {
    const secret = await newSecret();
    // A step after the one turning it on used up, so only storing the confirmation's own step stops its reuse.
    ctx.clock.advance(TOTP_STEP_MS);
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
    const attempts = await attemptsFrom(ctx.client.ip);
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      currentTotpCode: await code(),
      totpSecret: await newSecret(),
      totpCode: '000000',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_totp_code');
    expect(await storedSecret()).toBe(setup.totpSecret);
    // The new code is checked before re-authenticating, so this is not a sign-in attempt at all.
    expect(await attemptsFrom(ctx.client.ip)).toEqual(attempts);
  });

  it('keeps the recovery code if the confirmation code is wrong', async () => {
    const before = (await storedUser()).recoveryCodeHashes;
    const attempts = await attemptsFrom(ctx.client.ip);
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      recoveryCode: setup.recoveryCodes[1],
      totpSecret: await newSecret(),
      totpCode: '000000',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_totp_code');
    expect((await storedUser()).recoveryCodeHashes).toEqual(before);
    expect(await storedSecret()).toBe(setup.totpSecret);
    expect(await attemptsFrom(ctx.client.ip)).toEqual(attempts);
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
    expect(res).toEqual(WRONG_PASSWORD_OR_CODE);
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
    expect(res).toEqual(WRONG_PASSWORD_OR_CODE);
    expect(await storedSecret()).toBe(setup.totpSecret);
  });

  it('requires the current authenticator code or a recovery code, not both', async () => {
    const secret = await newSecret();
    const base = { currentPassword: TEST_PASSWORD, totpSecret: secret, totpCode: await totpCode(secret, ctx.clock.now()) };
    expect(await call(ctx.client, '/api/auth/totp', base)).toEqual(CODE_REQUIRED);
    const both = await call(ctx.client, '/api/auth/totp', {
      ...base,
      currentTotpCode: await code(),
      recoveryCode: setup.recoveryCodes[0],
    });
    expect(both.status).toBe(400);
    expect(both.body).toMatchObject({
      code: 'validation',
      formErrors: ['Enter either a code from your current authenticator app or a recovery code.'],
    });
    expect(await storedSecret()).toBe(setup.totpSecret);
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
      expect(res).toEqual(WRONG_PASSWORD_OR_CODE);
    }
    expect(await storedSecret()).toBe(setup.totpSecret);
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
    expect(await storedSecret()).toBe(secret);
    expect((await storedUser()).recoveryCodeHashes).toHaveLength(setup.recoveryCodes.length - 1);
    const reused = await new TestClient(ctx.app, '198.51.100.7').post('/api/auth/login', {
      password: TEST_PASSWORD,
      recoveryCode,
    });
    expect(reused.status).toBe(401);
  });

  it('signs out every other session', async () => {
    const { client: laptop } = await signIn('198.51.100.1', TEST_PASSWORD, setup.totpSecret);
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

describe('POST /api/auth/totp/disable', () => {
  it('is refused while no authenticator is on, without counting an attempt', async () => {
    const attempts = await attemptsFrom(ctx.client.ip);
    for (const factor of [{ totpCode: '123456' }, { recoveryCode: 'AAAA-AAAA-AAAA' }]) {
      expect(await call(ctx.client, '/api/auth/totp/disable', { currentPassword: TEST_PASSWORD, ...factor })).toEqual(
        NO_AUTHENTICATOR,
      );
    }
    expect(await attemptsFrom(ctx.client.ip)).toEqual(attempts);
  });

  describe('with an authenticator', () => {
    let setup: Authenticator;
    beforeEach(async () => {
      setup = await enableAuthenticator(ctx);
    });

    it('turns it off with the password and a code: sign-in takes the password only again', async () => {
      const res = await call(ctx.client, '/api/auth/totp/disable', {
        currentPassword: TEST_PASSWORD,
        totpCode: await freshTotpCode(setup.totpSecret, ctx.clock),
      });
      expect(res).toEqual({ status: 200, body: { ok: true } });
      expect(await storedUser()).toMatchObject({ totpSecretEnc: null, recoveryCodeHashes: [], totpLastStep: null });
      expect(await authenticatorEnabled()).toBe(false);
      expect(await signIn('198.51.100.1')).toMatchObject({
        status: 200,
        body: { authenticatorEnabled: false, recoveryCodesRemaining: 0 },
      });
    });

    it('turns it off with a recovery code (a lost phone)', async () => {
      const res = await call(ctx.client, '/api/auth/totp/disable', {
        currentPassword: TEST_PASSWORD,
        recoveryCode: setup.recoveryCodes[0],
      });
      expect(res.status).toBe(200);
      expect(await storedUser()).toMatchObject({ totpSecretEnc: null, recoveryCodeHashes: [], totpLastStep: null });
    });

    it('signs out every other session', async () => {
      const { client: laptop } = await signIn('198.51.100.1', TEST_PASSWORD, setup.totpSecret);
      const res = await call(ctx.client, '/api/auth/totp/disable', {
        currentPassword: TEST_PASSWORD,
        totpCode: await freshTotpCode(setup.totpSecret, ctx.clock),
      });
      expect(res.status).toBe(200);
      expect(await isSignedIn(laptop)).toBe(false);
      expect(await isSignedIn(ctx.client)).toBe(true);
    });

    it('refuses a wrong password or code and leaves it on', async () => {
      const before = await storedUser();
      const wrongPassword = await call(ctx.client, '/api/auth/totp/disable', {
        currentPassword: 'not it',
        totpCode: await freshTotpCode(setup.totpSecret, ctx.clock),
      });
      const wrongCode = await call(ctx.client, '/api/auth/totp/disable', { currentPassword: TEST_PASSWORD, totpCode: '000000' });
      const wrongRecoveryCode = await call(ctx.client, '/api/auth/totp/disable', {
        currentPassword: TEST_PASSWORD,
        recoveryCode: 'AAAA-AAAA-AAAA',
      });
      for (const res of [wrongPassword, wrongCode, wrongRecoveryCode]) expect(res).toEqual(WRONG_PASSWORD_OR_CODE);
      expect(await storedUser()).toEqual(before);
    });

    it('requires exactly one of the code and a recovery code', async () => {
      const totpCode = await freshTotpCode(setup.totpSecret, ctx.clock);
      for (const factor of [{}, { totpCode, recoveryCode: setup.recoveryCodes[0] }]) {
        const res = await call(ctx.client, '/api/auth/totp/disable', { currentPassword: TEST_PASSWORD, ...factor });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          code: 'validation',
          formErrors: ['Enter either a code from your authenticator app or a recovery code.'],
        });
      }
      expect(await storedSecret()).toBe(setup.totpSecret);
    });
  });
});

describe('POST /api/auth/recovery-codes', () => {
  it('is refused while no authenticator is on', async () => {
    const attempts = await attemptsFrom(ctx.client.ip);
    expect(await call(ctx.client, '/api/auth/recovery-codes', { currentPassword: TEST_PASSWORD })).toEqual(NO_AUTHENTICATOR);
    expect((await storedUser()).recoveryCodeHashes).toEqual([]);
    expect(await attemptsFrom(ctx.client.ip)).toEqual(attempts);
  });

  describe('with an authenticator', () => {
    let setup: Authenticator;
    beforeEach(async () => {
      setup = await enableAuthenticator(ctx);
    });
    const code = () => freshTotpCode(setup.totpSecret, ctx.clock);

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

    it('asks for the code when only the password is sent', async () => {
      expect(await call(ctx.client, '/api/auth/recovery-codes', { currentPassword: TEST_PASSWORD })).toEqual(CODE_REQUIRED);
    });

    it('keeps the old codes when the password or code is wrong', async () => {
      const wrongPassword = await call(ctx.client, '/api/auth/recovery-codes', { currentPassword: 'not it', totpCode: await code() });
      const wrongCode = await call(ctx.client, '/api/auth/recovery-codes', { currentPassword: TEST_PASSWORD, totpCode: '000000' });
      for (const res of [wrongPassword, wrongCode]) expect(res).toEqual(WRONG_PASSWORD_OR_CODE);
      const oldCode = await new TestClient(ctx.app, '198.51.100.5').post('/api/auth/login', {
        password: TEST_PASSWORD,
        recoveryCode: setup.recoveryCodes[0],
      });
      expect(oldCode.status).toBe(200);
    });
  });
});
