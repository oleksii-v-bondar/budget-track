import { describe, expect, it, vi } from 'vitest';
import { fakeApi, json } from '../test/fake-api';
import { api, ApiError, isTransient, isUnauthorized, NETWORK_ERROR_MESSAGE, unwrap } from './api';

/** The error a call fails with. */
const failure = (call: Promise<unknown>) =>
  call.then(
    () => expect.unreachable('the call should have failed'),
    (error: unknown) => error,
  );

describe('api client', () => {
  it('returns the JSON body of a successful call', async () => {
    fakeApi({ 'GET /api/auth/status': { body: { setupRequired: false, authenticated: true } } });
    const status = await unwrap(api.api.auth.status.$get());
    expect(status).toEqual({ setupRequired: false, authenticated: true });
  });

  it('sends JSON bodies with the CSRF header', async () => {
    const { requests } = fakeApi({ 'POST /api/auth/login': { body: { recoveryCodesRemaining: 10 } } });
    await unwrap(api.api.auth.login.$post({ json: { password: 'correct horse', totpCode: '123456' } }));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get('X-Requested-With')).toBe('budget-track');
    expect(requests[0]!.headers.get('content-type')).toMatch(/^application\/json/);
    expect(requests[0]!.body).toEqual({ password: 'correct horse', totpCode: '123456' });
  });

  it('keeps the dotted field paths of validation errors', async () => {
    const body = {
      code: 'validation',
      message: 'Some fields are invalid.',
      fieldErrors: { 'lines.1.amount': ['Enter an amount.'] },
      formErrors: ['Enter either a code or a recovery code.'],
    };
    fakeApi({ 'POST /api/undo': { status: 400, body } });
    const error = (await failure(unwrap(api.api.undo.$post()))) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'validation', message: 'Some fields are invalid.' });
    expect(error.fieldErrors).toEqual({ 'lines.1.amount': ['Enter an amount.'] });
    expect(error.formErrors).toEqual(['Enter either a code or a recovery code.']);
  });

  it('reports domain errors, conflicts and server errors with their code and message', async () => {
    const cases = [
      { status: 422, body: { code: 'account_not_empty', message: 'The balance must be 0 first.' } },
      { status: 409, body: { code: 'undo_conflict', message: "Can't undo: data changed since." } },
      { status: 500, body: { code: 'internal', message: 'Something went wrong.', requestId: 'req-1' } },
    ];
    for (const reply of cases) {
      fakeApi({ 'POST /api/undo': reply });
      const error = (await failure(unwrap(api.api.undo.$post()))) as ApiError;
      expect(error).toMatchObject({ status: reply.status, ...reply.body, fieldErrors: {}, retryAfter: null });
    }
  });

  it('reads Retry-After from 429 and 503 responses', async () => {
    const limited = { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a minute and try again.' };
    fakeApi({ 'POST /api/auth/login': json(limited, 429, { 'Retry-After': '30' }) });
    const error = await failure(unwrap(api.api.auth.login.$post({ json: { password: 'p', totpCode: '123456' } })));
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 30 });
  });

  it('turns a failed connection into a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    const error = await failure(unwrap(api.api.auth.status.$get()));
    expect(error).toMatchObject({ status: 0, code: 'network', message: NETWORK_ERROR_MESSAGE });
    expect(isTransient(error)).toBe(true);
  });

  it('copes with error pages that are not JSON', async () => {
    fakeApi({ 'GET /api/auth/status': new Response('<html>Bad gateway</html>', { status: 502 }) });
    const error = await failure(unwrap(api.api.auth.status.$get()));
    expect(error).toMatchObject({ status: 502, code: 'http_502', message: 'Something went wrong. Try again.' });
    expect(isTransient(error)).toBe(true);
  });

  it('tells an expired session apart from wrong credentials', () => {
    expect(isUnauthorized(new ApiError(401, { code: 'unauthorized', message: 'Please sign in.' }))).toBe(true);
    expect(isUnauthorized(new ApiError(401, { code: 'invalid_credentials', message: 'Wrong password or code.' }))).toBe(false);
    expect(isUnauthorized(new Error('nope'))).toBe(false);
  });
});
