import { useMutation } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { formErrorsOf } from '../lib/form-errors';
import { Button } from '../ui/button';
import { FormError, TextField } from '../ui/field';
import { authApi, useEnterApp } from './auth-api';

/** Sign-in with the username and password set in the server's environment. */
export function LoginScreen() {
  const { redirect } = useSearch({ from: '/auth/login' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const enterApp = useEnterApp();
  const login = useMutation({ mutationFn: authApi.login, onSuccess: () => enterApp(redirect) });
  const errors = formErrorsOf(login.error, ['username', 'password']);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ username, password });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-2xl bg-surface p-5 shadow-sm" noValidate>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <TextField
        label="Username"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        error={errors.fields.username}
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.fields.password}
      />
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={login.isPending} block>
        Sign in
      </Button>
    </form>
  );
}
