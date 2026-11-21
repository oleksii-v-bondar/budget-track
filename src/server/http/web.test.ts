import { describe, expect, it } from 'vitest';
import type { Db } from '../db/client';
import { createTestApp } from '../test/app';

// Serving files never touches the database.
const noDb = {} as Db;
const { client } = createTestApp(noDb);
const INDEX_TITLE = '<title>Budget Track (test build)</title>';

describe('the web app', () => {
  it('serves index.html at / and for the app routes, revalidated on every load', async () => {
    for (const path of ['/', '/index.html', '/budget', '/budget/2026-11', '/settings', '/accounts/4b0e6a51']) {
      const res = await client.get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
      expect(await res.text(), path).toContain(INDEX_TITLE);
    }
  });

  it('lets browsers keep hashed assets for a year', async () => {
    const res = await client.get('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toContain("'web app'");
  });

  it('revalidates the service worker and the manifest, so a new release is picked up', async () => {
    const sw = await client.get('/sw.js');
    expect(sw.status).toBe(200);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    const manifest = await client.get('/manifest.webmanifest');
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toMatch(/^application\/manifest\+json/);
    expect(manifest.headers.get('cache-control')).toBe('no-cache');
  });

  it('sends the strict CSP and security headers with the app', async () => {
    const res = await client.get('/budget');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('never answers /api or a missing file with the app', async () => {
    const notFound = { code: 'not_found', message: 'Not found.' };
    for (const path of ['/api', '/api/nope', '/api/budget.json', '/assets/missing.js', '/missing.png', '/assets/']) {
      const res = await client.get(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual(notFound);
    }
    expect((await client.post('/budget')).status).toBe(404);
  });

  it('serves only the API when the web app is not built', async () => {
    const apiOnly = createTestApp(noDb, { config: { webDir: 'no/such/dir' } }).client;
    const res = await apiOnly.get('/budget');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'not_found', message: 'Not found.' });
  });
});
