import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { LoginRequest, SetupRequest } from '../../shared/auth';
import { api, unwrap } from '../lib/api';
import { forgetSession, queryKeys } from '../lib/query';

/** The auth endpoints (spec §12). None of them is an undoable command. */
export const authApi = {
  setupSecret: (setupToken: string) => unwrap(api.api.auth.setup.totp.$post({ json: { setupToken } })),
  setup: (body: SetupRequest) => unwrap(api.api.auth.setup.$post({ json: body })),
  login: (body: LoginRequest) => unwrap(api.api.auth.login.$post({ json: body })),
  logout: () => unwrap(api.api.auth.logout.$post()),
};

/** Records a new session (after setup or sign-in) and opens `href` (default: the budget). */
export function useEnterApp() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (href = '/budget') => {
    queryClient.setQueryData(queryKeys.authStatus, { setupRequired: false, authenticated: true });
    return navigate({ href });
  };
}

/** Forgets the session's data and shows the sign-in page (after signing out). */
export function useLeaveApp() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return () => {
    forgetSession(queryClient);
    return navigate({ to: '/login' });
  };
}
