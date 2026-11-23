import { MutationCache, QueryCache, QueryClient, queryOptions } from '@tanstack/react-query';
import type { AuthStatus } from '../../shared/auth';
import { api, isTransient, isUnauthorized, unwrap } from './api';

/**
 * Query keys: `[area, ...params]`, e.g. `['budget', '2026-11']` or `['accounts']`. Every area except `auth` holds
 * budget data, which commands, undo and redo may change (see invalidateData).
 */
export const queryKeys = {
  authStatus: ['auth', 'status'],
  undo: ['undo'],
} as const;

/**
 * GET /api/auth/status: whether setup is needed, whether this browser is signed in, and whether sign-in asks for an
 * authenticator code. Route guards, the sign-in form and Settings read it.
 */
export const authStatusQuery = queryOptions({
  queryKey: queryKeys.authStatus,
  queryFn: () => unwrap(api.api.auth.status.$get()),
  // Changed only by setting the data (setAuthStatus) after setup, sign-in, sign-out, a 401 (see createQueryClient) and
  // turning the authenticator on or off.
  staleTime: Infinity,
});

/** Updates the cached auth status; what `change` leaves out keeps its cached value. */
export function setAuthStatus(queryClient: QueryClient, change: Partial<AuthStatus>): void {
  queryClient.setQueryData(authStatusQuery.queryKey, (old) => ({
    setupRequired: false,
    authenticated: false,
    authenticatorEnabled: false,
    ...old,
    ...change,
  }));
}

/**
 * The app's QueryClient. Spec §2: mutations wait for the server (no optimistic updates) and then refresh what they
 * changed. Any 401 `unauthorized` (an expired or revoked session) calls `onUnauthorized`, which sends the user to
 * sign in. Reads retry twice after network and server failures; mutations never retry on their own.
 */
export function createQueryClient(onUnauthorized: () => void): QueryClient {
  const signedOut = (error: unknown) => {
    if (isUnauthorized(error)) onUnauthorized();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError: signedOut }),
    mutationCache: new MutationCache({ onError: signedOut }),
    defaultOptions: {
      queries: { staleTime: 30_000, retry: (failures, error) => failures < 2 && isTransient(error) },
      mutations: { retry: false },
    },
  });
}

/** After a command, undo or redo: marks every budget-data query stale and refetches those on screen. */
export function invalidateData(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
}

/**
 * After signing out (or a 401): forgets every budget-data query and records that nobody is signed in. Whether sign-in
 * asks for a code stays as cached; the sign-in form learns otherwise from a 422 `code_required`.
 */
export function forgetSession(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
  setAuthStatus(queryClient, { setupRequired: false, authenticated: false });
}
