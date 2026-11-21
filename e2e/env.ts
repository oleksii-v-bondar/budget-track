/** The SETUP_TOKEN the end-to-end server runs with. */
export const E2E_SETUP_TOKEN = 'e2e-setup-token-0123456789';

/** Where global-setup started the server (set there, read by the tests). */
export const baseURL = () => {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error('E2E_BASE_URL is not set: run the tests with `npm run test:e2e`');
  return url;
};
