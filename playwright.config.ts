import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests against the built app (`npm run test:e2e` builds first) and a throwaway Postgres; see
 * e2e/global-setup.ts. Phone-sized, as the app is (spec §14: 390 × 844).
 */
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    trace: 'retain-on-failure',
  },
});
