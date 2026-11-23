import type { Config } from '../config';

export const TEST_USERNAME = 'owner';
export const TEST_PASSWORD = 'correct horse battery staple';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'postgres://unused/in-tests',
    appUsername: TEST_USERNAME,
    appPassword: TEST_PASSWORD,
    port: 0,
    timeZone: 'Europe/Warsaw',
    cookieSecure: true,
    logLevel: 'silent',
    migrationsDir: 'drizzle',
    // Tests use stubFx (src/server/test/fx.ts) or a local NBP stub server; nothing listens here.
    nbpBaseUrl: 'http://127.0.0.1:9',
    webDir: 'src/server/test/web-fixture',
    aiia: null,
    ...overrides,
  };
}
