import { totpCode } from './totp';
import type { TestApp } from './app';
import { TEST_SETUP_TOKEN } from './config';

export const TEST_PASSWORD = 'correct horse battery staple';

export interface SetupResult {
  totpSecret: string;
  recoveryCodes: string[];
}

/** Runs first-run setup through the API (leaving `client` signed in) and returns the secrets it created. */
export async function setUpBudget({ client, clock }: TestApp): Promise<SetupResult> {
  const totpResponse = await client.post('/api/auth/setup/totp', { setupToken: TEST_SETUP_TOKEN });
  const { secret } = (await totpResponse.json()) as { secret: string };
  const response = await client.post('/api/auth/setup', {
    setupToken: TEST_SETUP_TOKEN,
    password: TEST_PASSWORD,
    totpSecret: secret,
    totpCode: await totpCode(secret, clock.now()),
  });
  if (response.status !== 201) throw new Error(`setup failed: ${response.status} ${await response.text()}`);
  const { recoveryCodes } = (await response.json()) as { recoveryCodes: string[] };
  return { totpSecret: secret, recoveryCodes };
}
