import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const validEnv = {
  DATABASE_URL: 'postgres://budget:secret@localhost:5432/budget',
  APP_USERNAME: 'owner',
  APP_PASSWORD: 'correct horse battery staple',
};

describe('loadConfig', () => {
  it('applies defaults for optional variables', () => {
    expect(loadConfig(validEnv)).toEqual({
      databaseUrl: validEnv.DATABASE_URL,
      appUsername: 'owner',
      appPassword: 'correct horse battery staple',
      port: 3000,
      timeZone: 'Europe/Warsaw',
      cookieSecure: true,
      logLevel: 'info',
      migrationsDir: 'drizzle',
      nbpBaseUrl: 'https://api.nbp.pl',
      webDir: 'dist/web',
      enableBanking: null,
    });
  });

  it('parses explicit values', () => {
    const config = loadConfig({
      ...validEnv,
      PORT: '8080',
      TZ: 'UTC',
      COOKIE_SECURE: 'false',
      LOG_LEVEL: 'silent',
      MIGRATIONS_DIR: '/app/drizzle',
      NBP_BASE_URL: 'http://localhost:8081/',
      WEB_DIR: '/app/web',
    });
    expect(config).toMatchObject({
      port: 8080,
      timeZone: 'UTC',
      cookieSecure: false,
      logLevel: 'silent',
      migrationsDir: '/app/drizzle',
      nbpBaseUrl: 'http://localhost:8081',
      webDir: '/app/web',
    });
  });

  it('turns Enable Banking on only with an app id and a readable private key', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const read: string[] = [];
    const files = (contents: Record<string, string>) => (path: string) => {
      read.push(path);
      if (!(path in contents)) throw new Error(`ENOENT: ${path}`);
      return contents[path]!;
    };
    const env = { ...validEnv, ENABLE_BANKING_APP_ID: ' app-id ' };

    const config = loadConfig(env, files({ './secrets/enablebanking.pem': pem }));
    expect(config.enableBanking).toEqual({
      appId: 'app-id',
      privateKey: expect.anything(),
      baseUrl: 'https://api.enablebanking.com',
      redirectUri: 'http://localhost:3080/api/bank/callback',
    });
    expect(config.enableBanking?.privateKey.asymmetricKeyType).toBe('rsa');
    const custom = loadConfig(
      { ...env, ENABLE_BANKING_KEY_FILE: '/keys/app.pem', BANK_REDIRECT_URI: 'https://budget.example.com/api/bank/callback' },
      files({ '/keys/app.pem': pem }),
    );
    expect(custom.enableBanking).toMatchObject({ redirectUri: 'https://budget.example.com/api/bank/callback' });

    expect(loadConfig(env, files({})).enableBanking).toBeNull();
    expect(loadConfig(env, files({ './secrets/enablebanking.pem': 'not a key' })).enableBanking).toBeNull();
    expect(loadConfig({ ...env, ENABLE_BANKING_APP_ID: '' }, files({ './secrets/enablebanking.pem': pem })).enableBanking)
      .toBeNull();
    expect(read).toEqual(['./secrets/enablebanking.pem', '/keys/app.pem', './secrets/enablebanking.pem', './secrets/enablebanking.pem']);
    expect(() => loadConfig({ ...validEnv, BANK_REDIRECT_URI: 'javascript:alert(1)' })).toThrow('BANK_REDIRECT_URI');
  });

  it('lists every invalid variable in one error', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*APP_USERNAME[\s\S]*APP_PASSWORD/);
  });

  it('rejects an empty username or password, unknown time zones and bad booleans', () => {
    expect(() => loadConfig({ ...validEnv, APP_USERNAME: '' })).toThrow('APP_USERNAME');
    expect(() => loadConfig({ ...validEnv, APP_PASSWORD: '' })).toThrow('APP_PASSWORD');
    expect(() => loadConfig({ ...validEnv, TZ: 'Mars/Olympus' })).toThrow('TZ');
    expect(() => loadConfig({ ...validEnv, COOKIE_SECURE: 'yes' })).toThrow('COOKIE_SECURE');
    expect(() => loadConfig({ ...validEnv, NBP_BASE_URL: 'ftp://api.nbp.pl' })).toThrow('NBP_BASE_URL');
  });
});
