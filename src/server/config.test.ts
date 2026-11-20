import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const KEY = Buffer.alloc(32, 7).toString('base64');

const validEnv = {
  DATABASE_URL: 'postgres://budget:secret@localhost:5432/budget',
  ENCRYPTION_KEY: KEY,
  SETUP_TOKEN: 'a-long-setup-token-123',
};

describe('loadConfig', () => {
  it('applies defaults for optional variables', () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      databaseUrl: validEnv.DATABASE_URL,
      setupToken: validEnv.SETUP_TOKEN,
      port: 3000,
      timeZone: 'Europe/Warsaw',
      cookieSecure: true,
      trustProxy: false,
      logLevel: 'info',
      migrationsDir: 'drizzle',
    });
    expect(config.encryptionKey).toEqual(Buffer.alloc(32, 7));
  });

  it('parses explicit values', () => {
    const config = loadConfig({
      ...validEnv,
      PORT: '8080',
      TZ: 'UTC',
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'true',
      LOG_LEVEL: 'silent',
      MIGRATIONS_DIR: '/app/drizzle',
    });
    expect(config).toMatchObject({
      port: 8080,
      timeZone: 'UTC',
      cookieSecure: false,
      trustProxy: true,
      logLevel: 'silent',
      migrationsDir: '/app/drizzle',
    });
  });

  it('lists every invalid variable in one error', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*ENCRYPTION_KEY[\s\S]*SETUP_TOKEN/);
  });

  it('rejects keys that are not exactly 32 bytes of base64', () => {
    const short = Buffer.alloc(16, 1).toString('base64');
    expect(() => loadConfig({ ...validEnv, ENCRYPTION_KEY: short })).toThrow('ENCRYPTION_KEY');
  });

  it('rejects unknown time zones, short setup tokens and bad booleans', () => {
    expect(() => loadConfig({ ...validEnv, TZ: 'Mars/Olympus' })).toThrow('TZ');
    expect(() => loadConfig({ ...validEnv, SETUP_TOKEN: 'short' })).toThrow('SETUP_TOKEN');
    expect(() => loadConfig({ ...validEnv, COOKIE_SECURE: 'yes' })).toThrow('COOKIE_SECURE');
  });
});
