import type { TestApp } from './app';
import { TEST_SETUP_TOKEN } from './config';
import { totpCode } from './totp';

export const TEST_PASSWORD = 'correct horse battery staple';

/** Runs first-run setup through the API (a password, no authenticator), leaving `client` signed in. */
export async function setUpBudget({ client }: TestApp): Promise<void> {
  const response = await client.post('/api/auth/setup', { setupToken: TEST_SETUP_TOKEN, password: TEST_PASSWORD });
  if (response.status !== 201) throw new Error(`setup failed: ${response.status} ${await response.text()}`);
}

export interface Authenticator {
  totpSecret: string;
  recoveryCodes: string[];
}

/**
 * Turns on an authenticator app through Settings, as the signed-in `client` (none may be on yet), and returns its
 * secret and recovery codes. The code that confirmed it is used up, so take later codes with `freshTotpCode`. Other
 * sessions are signed out.
 */
export async function enableAuthenticator({ client, clock }: TestApp): Promise<Authenticator> {
  const { secret } = (await (await client.post('/api/auth/totp/secret')).json()) as { secret: string };
  const response = await client.post('/api/auth/totp', {
    currentPassword: TEST_PASSWORD,
    totpSecret: secret,
    totpCode: await totpCode(secret, clock.now()),
  });
  if (response.status !== 200) {
    throw new Error(`turning the authenticator on failed: ${response.status} ${await response.text()}`);
  }
  const { recoveryCodes } = (await response.json()) as { recoveryCodes: string[] };
  return { totpSecret: secret, recoveryCodes };
}
