import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { LoginRequest } from '../../shared/auth';
import { api, unwrap } from '../lib/api';
import { errorMessage } from '../lib/commands';
import { forgetSession, setAuthStatus } from '../lib/query';
import { useToast } from '../ui/toast';

/** The auth endpoints. Neither is an undoable command. */
export const authApi = {
  login: (body: LoginRequest) => unwrap(api.api.auth.login.$post({ json: body })),
  logout: () => unwrap(api.api.auth.logout.$post()),
};

/** Records a new session (after sign-in), then opens `href` (default: Home). */
export function useEnterApp() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (href = '/home') => {
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

/** Sign out (Settings and the "…" menu); a failure shows a toast. */
export function useSignOut() {
  const toast = useToast();
  const leaveApp = useLeaveApp();
  return useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => leaveApp(),
    onError: (error) => toast.show({ tone: 'error', message: errorMessage(error) }),
  });
}
