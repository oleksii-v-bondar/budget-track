import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type {
  ChangePasswordRequest,
  ConfirmTotpRequest,
  DisableTotpRequest,
  LoginRequest,
  ReauthRequest,
  SetupRequest,
} from '../../shared/auth';
import { api, unwrap } from '../lib/api';
import { forgetSession, setAuthStatus } from '../lib/query';

/** The auth endpoints (spec §12). None of them is an undoable command. */
export const authApi = {
  setup: (body: SetupRequest) => unwrap(api.api.auth.setup.$post({ json: body })),
  login: (body: LoginRequest) => unwrap(api.api.auth.login.$post({ json: body })),
  logout: () => unwrap(api.api.auth.logout.$post()),
  logoutAll: () => unwrap(api.api.auth['logout-all'].$post()),
  changePassword: (body: ChangePasswordRequest) => unwrap(api.api.auth.password.$post({ json: body })),
  newTotpSecret: () => unwrap(api.api.auth.totp.secret.$post()),
  confirmTotp: (body: ConfirmTotpRequest) => unwrap(api.api.auth.totp.$post({ json: body })),
  disableTotp: (body: DisableTotpRequest) => unwrap(api.api.auth.totp.disable.$post({ json: body })),
  newRecoveryCodes: (body: ReauthRequest) => unwrap(api.api.auth['recovery-codes'].$post({ json: body })),
};

/**
 * Records a new session (after setup or sign-in) and whether sign-in asks for an authenticator code, then opens
 * `href` (default: the budget).
 */
export function useEnterApp() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return ({ href = '/budget', authenticatorEnabled }: { href?: string; authenticatorEnabled: boolean }) => {
    setAuthStatus(queryClient, { setupRequired: false, authenticated: true, authenticatorEnabled });
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
