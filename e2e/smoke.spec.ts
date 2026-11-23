// The callbacks passed to page.evaluate and addInitScript run in the browser.
/// <reference lib="dom" />
import { expect, type Page, test } from '@playwright/test';
import { baseURL, E2E_PASSWORD, E2E_USERNAME } from './env';

test.use({ baseURL: baseURL() });

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

async function signIn(page: Page) {
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await page.getByLabel('Username').fill(E2E_USERNAME);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Budget' })).toBeVisible();
}

test('sign in, open Settings, sign out and sign in again', async ({ page }) => {
  const cspViolations = await watchCsp(page);

  // 1. A signed-out visit goes to sign-in; a wrong password is refused.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await page.getByLabel('Username').fill(E2E_USERNAME);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong username or password.');
  await signIn(page);

  // 2. Settings from the bottom navigation, then sign out.
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // 3. Sign in again. A full page load of a deep link: the service worker answers it with the app shell.
  await signIn(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  const worker = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  expect(worker).toBe(`${baseURL()}/sw.js`);
  // /api never comes from the service worker, not even as a page load.
  const status = await page.goto('/api/auth/status');
  expect(await status!.json()).toEqual({ authenticated: true });
  expect(cspViolations).toEqual([]);
});
