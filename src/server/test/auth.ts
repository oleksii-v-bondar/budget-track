import { monthIn } from '../clock';
import { ensureBudget } from '../db/seed';
import type { TestApp } from './app';
import { TEST_PASSWORD, TEST_USERNAME } from './config';

/** Creates the budget as the server does on first start, and signs `client` in with the test credentials. */
export async function setUpBudget({ db, client, clock, config }: TestApp): Promise<void> {
  await ensureBudget(db, monthIn(config.timeZone, clock.now()));
  const response = await client.post('/api/auth/login', { username: TEST_USERNAME, password: TEST_PASSWORD });
  if (response.status !== 200) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
}
