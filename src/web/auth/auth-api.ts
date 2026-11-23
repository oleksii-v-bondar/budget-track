import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { LoginRequest } from '../../shared/auth';
import { api, unwrap } from '../lib/api';
import { forgetSession, setAuthStatus } from '../lib/query';

/** The auth endpoints. Neither is an undoable command. */
export const authApi = {
  login: (body: LoginRequest) => unwrap(api.api.auth.login.$post({ json: body })),
  logout: () => unwrap(api.api.auth.logout.$post()),
};

/** Records a new session (after sign-in), then opens `href` (default: the budget). */
export function useEnterApp() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (href = '/budget') => {
    setAuthStatus(queryClient, { authenticated: true });
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
