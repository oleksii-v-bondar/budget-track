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

async function signIn(page: Page, factor: { totpCode: string } | { recoveryCode: string }) {
  await page.getByLabel('Password').fill(PASSWORD);
  if ('totpCode' in factor) {
    await page.getByLabel('Authenticator code').fill(factor.totpCode);
  } else {
    await page.getByRole('radio', { name: 'Recovery code' }).click();
    await page.getByLabel('Recovery code').fill(factor.recoveryCode);
  }
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Budget' })).toBeVisible();
}

test('setup, sign-in with either factor, settings and sign-out', async ({ page }) => {
  const cspViolations = await watchCsp(page);

  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Setup token').fill(E2E_SETUP_TOKEN);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat the password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const secret = (await page.getByTestId('totp-secret').textContent())!.replace(/\s/g, '');
  await page.getByLabel('Code from the app').fill(await generate({ secret }));
  await page.getByRole('button', { name: 'Finish setup' }).click();
  const codes = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codes).toHaveCount(10);
  const recoveryCodes = await codes.allTextContents();
  await page.getByLabel("I've saved my recovery codes").check();
  await page.getByRole('button', { name: 'Continue to the budget' }).click();
  await expect(page.getByRole('heading', { name: 'Budget' })).toBeVisible();

  await page.getByRole('link', { name: 'More' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, { totpCode: await nextCode(secret) });

  // A full page load of a deep link: the service worker answers it with the app shell.
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, { recoveryCode: recoveryCodes[0]! });

  const worker = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  expect(worker).toBe(`${baseURL()}/sw.js`);
  // /api never comes from the service worker, not even as a page load.
  const status = await page.goto('/api/auth/status');
  expect(await status!.json()).toEqual({ setupRequired: false, authenticated: true });
  expect(cspViolations).toEqual([]);
});
