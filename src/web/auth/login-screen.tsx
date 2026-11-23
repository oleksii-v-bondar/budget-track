import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../lib/api';
import { formErrorsOf } from '../lib/form-errors';
import { authStatusQuery, setAuthStatus } from '../lib/query';
import { Button } from '../ui/button';
import { FormError, SegmentedControl, TextField } from '../ui/field';
import { useToast } from '../ui/toast';
import { authApi, useEnterApp } from './auth-api';

type Factor = 'totp' | 'recovery';

const FACTORS = [
  { value: 'totp', label: 'Authenticator code' },
  { value: 'recovery', label: 'Recovery code' },
] as const;

/** Warn when this few recovery codes are left. */
const LOW_RECOVERY_CODES = 3;

/**
 * Sign-in (spec §12): the password, plus an authenticator code or a recovery code once the owner has turned on an
 * authenticator app (the auth status says so).
 */
export function LoginScreen() {
  const { redirect } = useSearch({ from: '/auth/login' });
  const queryClient = useQueryClient();
  const authenticatorEnabled = useQuery(authStatusQuery).data?.authenticatorEnabled ?? false;
  const [factor, setFactor] = useState<Factor>('totp');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const enterApp = useEnterApp();
  const toast = useToast();
  const login = useMutation({
    mutationFn: authApi.login,
    onSuccess: (response) => {
      if (response.authenticatorEnabled && response.recoveryCodesRemaining <= LOW_RECOVERY_CODES) {
        toast.show({
          message: `Only ${response.recoveryCodesRemaining} recovery codes left. Make new ones in Settings.`,
          duration: 10_000,
        });
      }
      return enterApp({ href: redirect, authenticatorEnabled: response.authenticatorEnabled });
    },
    onError: (error) => {
      // The authenticator was turned on since the status was read: show the code field.
      if (error instanceof ApiError && error.code === 'code_required') {
        setAuthStatus(queryClient, { authenticatorEnabled: true });
      }
    },
  });
  const errors = formErrorsOf(login.error, ['password', 'totpCode', 'recoveryCode']);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // An empty code sends the password alone: the cached status may be stale (the authenticator turned off elsewhere),
    // and if one is on the server answers 422 `code_required`, which keeps the code field.
    if (!authenticatorEnabled || code === '') login.mutate({ password });
    else login.mutate(factor === 'totp' ? { password, totpCode: code } : { password, recoveryCode: code });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-2xl bg-white p-5 shadow-sm" noValidate>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.fields.password}
      />
      {authenticatorEnabled && (
        <>
          <SegmentedControl
            label="Second factor"
            value={factor}
            options={FACTORS}
            onChange={(value) => {
              setFactor(value);
              setCode('');
            }}
          />
          {factor === 'totp' ? (
            <TextField
              key="totp"
              label="Authenticator code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              error={errors.fields.totpCode}
            />
          ) : (
            <TextField
              key="recovery"
              label="Recovery code"
              autoComplete="off"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              error={errors.fields.recoveryCode}
            />
          )}
        </>
      )}
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={login.isPending} block>
        Sign in
      </Button>
    </form>
  );
}
