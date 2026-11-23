import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { createQueryClient, forgetSession, invalidateData, queryKeys, setAuthStatus } from './query';

const unauthorized = new ApiError(401, { code: 'unauthorized', message: 'Please sign in.' });
const wrongPassword = new ApiError(401, { code: 'invalid_credentials', message: 'Wrong password or code.' });

describe('createQueryClient', () => {
  it('reports an expired session from any query or mutation, but not a failed sign-in', async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient(onUnauthorized);
    await client.fetchQuery({ queryKey: ['budget', '2026-11'], queryFn: () => Promise.reject(unauthorized) }).catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const mutate = (error: ApiError) =>
      client.getMutationCache().build(client, { mutationFn: () => Promise.reject(error) }).execute(undefined).catch(() => {});
    await mutate(unauthorized);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
    await mutate(wrongPassword);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it('retries reads only after network and server failures', () => {
    const retry = createQueryClient(() => {}).getDefaultOptions().queries!.retry as (n: number, e: unknown) => boolean;
    expect(retry(0, new ApiError(0, { code: 'network', message: '' }))).toBe(true);
    expect(retry(1, new ApiError(503, { code: 'busy', message: '' }))).toBe(true);
    expect(retry(2, new ApiError(503, { code: 'busy', message: '' }))).toBe(false);
    expect(retry(0, new ApiError(422, { code: 'x', message: '' }))).toBe(false);
    expect(retry(0, unauthorized)).toBe(false);
  });
});

describe('cache helpers', () => {
  function seeded() {
    const client = new QueryClient();
    client.setQueryData(queryKeys.authStatus, { setupRequired: false, authenticated: true, authenticatorEnabled: true });
    client.setQueryData(['budget', '2026-11'], { month: '2026-11' });
    client.setQueryData(queryKeys.undo, { undo: null, redo: null });
    return client;
  }

  it('invalidateData marks every budget-data query stale, but not the auth status', async () => {
    const client = seeded();
    await invalidateData(client);
    const stale = (key: readonly unknown[]) => client.getQueryState(key)!.isInvalidated;
    expect([stale(['budget', '2026-11']), stale(queryKeys.undo), stale(queryKeys.authStatus)]).toEqual([true, true, false]);
  });

  it('forgetSession drops the budget data and records that nobody is signed in', () => {
    const client = seeded();
    forgetSession(client);
    expect(client.getQueryData(['budget', '2026-11'])).toBeUndefined();
    expect(client.getQueryData(queryKeys.undo)).toBeUndefined();
    // Sign-in still asks for a code.
    expect(client.getQueryData(queryKeys.authStatus)).toEqual({
      setupRequired: false,
      authenticated: false,
      authenticatorEnabled: true,
    });
  });

  it('setAuthStatus changes only what it is given, and fills in an empty cache', () => {
    const client = seeded();
    setAuthStatus(client, { authenticatorEnabled: false });
    expect(client.getQueryData(queryKeys.authStatus)).toEqual({
      setupRequired: false,
      authenticated: true,
      authenticatorEnabled: false,
    });
    const empty = new QueryClient();
    setAuthStatus(empty, { authenticated: true });
    expect(empty.getQueryData(queryKeys.authStatus)).toEqual({
      setupRequired: false,
      authenticated: true,
      authenticatorEnabled: false,
    });
  });
});
