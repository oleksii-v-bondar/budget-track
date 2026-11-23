/** The credentials the end-to-end server runs with (APP_USERNAME, APP_PASSWORD). */
export const E2E_USERNAME = 'owner';
export const E2E_PASSWORD = 'correct horse battery staple';

/** Where global-setup started the server (set there, read by the tests). */
export const baseURL = () => {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error('E2E_BASE_URL is not set: run the tests with `npm run test:e2e`');
  return url;
};
