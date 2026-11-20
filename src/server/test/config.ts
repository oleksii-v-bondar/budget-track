import type { Config } from '../config';

export const TEST_SETUP_TOKEN = 'test-setup-token-0123456789';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'postgres://unused/in-tests',
    encryptionKey: Buffer.alloc(32, 1),
    setupToken: TEST_SETUP_TOKEN,
    port: 0,
    timeZone: 'Europe/Warsaw',
    cookieSecure: true,
    // Tests identify clients by X-Forwarded-For.
    trustProxy: true,
    logLevel: 'silent',
    migrationsDir: 'drizzle',
    ...overrides,
  };
}
