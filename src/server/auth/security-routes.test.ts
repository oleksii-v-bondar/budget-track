import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appUser, session } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { type SetupResult, setUpBudget, TEST_PASSWORD } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { TestClient } from '../test/http-client';
import { totpCode } from '../test/totp';
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
  const res = await client.post('/api/auth/login', { password, totpCode: await totpCode(secret, ctx.clock.now()) });
  return { client, status: res.status };
}

const code = () => totpCode(setup.totpSecret, ctx.clock.now());

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
  });

  it('refuses without the current password and code', async () => {
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
  });
});

describe('authenticator rotation', () => {
  it('switches to a new secret once a code from it is confirmed', async () => {
    const { body } = await call(ctx.client, '/api/auth/totp/secret');
    const newSecret = body.secret as string;
    expect(newSecret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.uri).toContain(newSecret);

    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      totpSecret: newSecret,
      totpCode: await totpCode(newSecret, ctx.clock.now()),
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const [user] = await t.db.select().from(appUser);
    expect(decryptSecret(user!.totpSecretEnc, ctx.config.encryptionKey)).toBe(newSecret);
    expect((await signIn('198.51.100.3', TEST_PASSWORD, newSecret)).status).toBe(200);
    expect((await signIn('198.51.100.4', TEST_PASSWORD, setup.totpSecret)).status).toBe(401);
  });

  it('keeps the old secret if the confirmation code is wrong', async () => {
    const { body } = await call(ctx.client, '/api/auth/totp/secret');
    const res = await call(ctx.client, '/api/auth/totp', {
      currentPassword: TEST_PASSWORD,
      totpSecret: body.secret,
      totpCode: '000000',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_totp_code');
    const [user] = await t.db.select().from(appUser);
    expect(decryptSecret(user!.totpSecretEnc, ctx.config.encryptionKey)).toBe(setup.totpSecret);
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
});
