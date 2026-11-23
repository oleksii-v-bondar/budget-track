// The callbacks passed to page.evaluate and addInitScript run in the browser.
/// <reference lib="dom" />
import { expect, type Page, test } from '@playwright/test';
import { generate } from 'otplib';
import { baseURL, E2E_SETUP_TOKEN } from './env';

test.use({ baseURL: baseURL() });

const PASSWORD = 'correct horse battery staple';

/**
 * A code from the next 30 s step: the server's ±1 step window accepts it, and it is newer than the code used just
 * before (each code works once).
 */
const nextCode = (secret: string) => generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });

/** Collects Content-Security-Policy violations on every page load, to check that the built app needs no exceptions. */
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction('reportCspViolation', (violation: string) => violations.push(violation));
  await page.addInitScript(() => {
    const report = (window as unknown as { reportCspViolation: (v: string) => void }).reportCspViolation;
    document.addEventListener('securitypolicyviolation', (e) =>
      report(`${e.violatedDirective} (${e.blockedURI}) at ${e.sourceFile}:${e.lineNumber} on ${location.pathname}`),
    );
  });
  return violations;
}

/** Signs in with the password, plus `totpCode` while an authenticator is on (without one there is no code field). */
async function signIn(page: Page, totpCode?: string) {
  await page.getByLabel('Password').fill(PASSWORD);
  if (totpCode === undefined) await expect(page.getByLabel('Authenticator code')).toHaveCount(0);
  else await page.getByLabel('Authenticator code').fill(totpCode);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Budget' })).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test('setup with a password, then turning the authenticator app on and off', async ({ page }) => {
  // Step 6 waits for the sign-in rate limit (below).
  test.setTimeout(120_000);
  const cspViolations = await watchCsp(page);

  // 1. Setup: the setup token and a password, no authenticator.
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Setup token').fill(E2E_SETUP_TOKEN);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat the password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByRole('heading', { name: 'Budget' })).toBeVisible();
  const setUpAt = Date.now();

  // 2. Sign out, and back in with the password only.
  await page.getByRole('link', { name: 'More' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await signOut(page);
  await signIn(page);

  // 3. Turn the authenticator on. A full page load of a deep link: the service worker answers it with the app shell.
  await page.goto('/settings');
  const authenticator = page.getByRole('region', { name: 'Authenticator app' });
  await expect(authenticator).toContainText('Off');
  await authenticator.getByRole('button', { name: 'Turn on' }).click();
  const turnOn = page.getByRole('dialog', { name: 'Turn on authenticator app' });
  await turnOn.getByLabel('Current password').fill(PASSWORD);
  await turnOn.getByRole('button', { name: 'Continue' }).click();
  await expect(turnOn.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const secret = (await turnOn.getByTestId('totp-secret').textContent())!.replace(/\s/g, '');
  await turnOn.getByLabel('Code from the app').fill(await generate({ secret }));
  await turnOn.getByRole('button', { name: 'Turn on' }).click();
  const codes = turnOn.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codes).toHaveCount(10);
  const recoveryCodes = await codes.allTextContents();
  await turnOn.getByLabel("I've saved my recovery codes").check();
  await turnOn.getByRole('button', { name: 'Done' }).click();
  await expect(authenticator.getByRole('button', { name: 'Turn off' })).toBeVisible();

  // 4. Sign out everywhere, then sign in with the password and a code.
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, await nextCode(secret));

  // 5. Turn it off, confirming with a recovery code (the next authenticator code is up to 30 s away).
  await page.goto('/settings');
  await authenticator.getByRole('button', { name: 'Turn off' }).click();
  const turnOff = page.getByRole('dialog', { name: 'Turn off authenticator app' });
  await turnOff.getByLabel('Current password').fill(PASSWORD);
  await turnOff.getByRole('radio', { name: 'Recovery code' }).click();
  await turnOff.getByLabel('Recovery code').fill(recoveryCodes[0]!);
  await turnOff.getByLabel('Sign in with the password only from now on').check();
  await turnOff.getByRole('button', { name: 'Turn off' }).click();
  await expect(authenticator.getByRole('button', { name: 'Turn on' })).toBeVisible();

  // 6. Sign out, and back in with the password only. Setup, sign-ins and re-authentications all count toward the limit
  // of 5 attempts per minute per IP (spec §12), so this sixth one waits until setup's is a minute old.
  await signOut(page);
  await page.waitForTimeout(Math.max(0, setUpAt + 61_000 - Date.now()));
  await signIn(page);

  const worker = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  expect(worker).toBe(`${baseURL()}/sw.js`);
  // /api never comes from the service worker, not even as a page load.
  const status = await page.goto('/api/auth/status');
  expect(await status!.json()).toEqual({ setupRequired: false, authenticated: true, authenticatorEnabled: false });
  expect(cspViolations).toEqual([]);
});
