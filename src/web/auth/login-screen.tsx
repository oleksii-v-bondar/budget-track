import { useMutation } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { formErrorsOf } from '../lib/form-errors';
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

/** Sign-in (spec §12): the password plus an authenticator code, or plus a recovery code. */
export function LoginScreen() {
  const { redirect } = useSearch({ from: '/auth/login' });
  const [factor, setFactor] = useState<Factor>('totp');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const enterApp = useEnterApp();
  const toast = useToast();
  const login = useMutation({
    mutationFn: authApi.login,
    onSuccess: ({ recoveryCodesRemaining }) => {
      if (recoveryCodesRemaining <= LOW_RECOVERY_CODES) {
        toast.show({
          message: `Only ${recoveryCodesRemaining} recovery codes left. Make new ones in Settings.`,
          duration: 10_000,
        });
      }
      return enterApp(redirect);
    },
  });
  const errors = formErrorsOf(login.error, ['password', 'totpCode', 'recoveryCode']);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate(factor === 'totp' ? { password, totpCode: code } : { password, recoveryCode: code });
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
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={login.isPending} block>
        Sign in
      </Button>
    </form>
  );
}
