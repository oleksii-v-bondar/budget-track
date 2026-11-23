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
      aiia: null,
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
      AIIA_CLIENT_ID: 'id',
      AIIA_CLIENT_SECRET: 'secret',
      AIIA_BASE_URL: 'https://api-sandbox.aiia.eu/',
    });
    expect(config).toMatchObject({
      port: 8080,
      timeZone: 'UTC',
      cookieSecure: false,
      logLevel: 'silent',
      migrationsDir: '/app/drizzle',
      nbpBaseUrl: 'http://localhost:8081',
      webDir: '/app/web',
      aiia: {
        clientId: 'id',
        clientSecret: 'secret',
        baseUrl: 'https://api-sandbox.aiia.eu',
        redirectUri: 'http://localhost:3080/api/bank/callback',
      },
    });
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
