// The callbacks passed to page.evaluate run in the browser.
/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { baseURL } from './env';

test.use({ baseURL: baseURL() });

test('the service worker takes over at once, so a new deploy never waits for the app to close', async ({ page, request }) => {
  const sw = await (await request.get('/sw.js')).text();
  // A new version activates as soon as it is installed, not when a SKIP_WAITING message arrives (nothing sends one).
  expect(sw).toContain('self.skipWaiting()');
  expect(sw).not.toContain('SKIP_WAITING');
  expect(sw).toContain('clientsClaim()');

  // It also controls the pages that are already open, without a reload.
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 15_000 })
    .toBe(true);
});
