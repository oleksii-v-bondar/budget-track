import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { PASSWORD_MIN_LENGTH, setupRequestSchema } from '../../shared/auth';
import { ApiError } from '../lib/api';
import { type FormErrors, formErrorsOf, NO_ERRORS, zodFormErrors } from '../lib/form-errors';
import { setAuthStatus } from '../lib/query';
import { Button } from '../ui/button';
import { FormError, TextField } from '../ui/field';
import { authApi, useEnterApp } from './auth-api';

type Step = 'token' | 'password';

const isAlreadySetUp = (error: unknown) => error instanceof ApiError && error.code === 'already_setup';
const isTokenRefused = (error: unknown) =>
  error instanceof ApiError && (error.code === 'invalid_setup_token' || 'setupToken' in error.fieldErrors);

function SignInLink() {
  return (
    <Link to="/login" className="text-brand underline">
      Go to sign in
    </Link>
  );
}

const STEP_TITLES: Record<Step, string> = {
  token: 'Set up your budget',
  password: 'Choose a password',
};

/**
 * First-run setup (spec §12): the setup token, then a password. Setup signs the owner in and continues into the app;
 * the authenticator app is off until it is turned on in Settings. The server checks the token only at the end, so a
 * refused token brings back its step.
 */
export function SetupScreen() {
  const [step, setStep] = useState<Step>('token');
  const [setupToken, setSetupToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [tokenErrors, setTokenErrors] = useState<FormErrors>(NO_ERRORS);
  const [passwordErrors, setPasswordErrors] = useState<FormErrors>(NO_ERRORS);
  const enterApp = useEnterApp();
  const queryClient = useQueryClient();

  const setup = useMutation({
    mutationFn: authApi.setup,
    onSuccess: () => enterApp({ authenticatorEnabled: false }),
    onError: (error) => {
      if (isTokenRefused(error)) {
        setTokenErrors(formErrorsOf(error, ['setupToken']));
        setStep('token');
      }
      // The cached status (never stale) still says setup is required, so the sign-in route's guard would send the
      // owner back here.
      if (isAlreadySetUp(error)) setAuthStatus(queryClient, { setupRequired: false, authenticated: false });
    },
  });
  const setupErrors = formErrorsOf(setup.error, ['password']);

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    const checked = setupRequestSchema.pick({ setupToken: true }).safeParse({ setupToken });
    if (!checked.success) setTokenErrors(zodFormErrors(checked.error, ['setupToken']));
    else {
      setTokenErrors(NO_ERRORS);
      setup.reset();
      setStep('password');
    }
  };
  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    // The shared schema finds a weak password before anything is sent.
    const checked = setupRequestSchema.pick({ password: true }).safeParse({ password });
    if (!checked.success) setPasswordErrors(zodFormErrors(checked.error, ['password']));
    else if (confirm !== password) setPasswordErrors({ fields: { confirm: "The passwords don't match." }, form: null });
    else {
      setPasswordErrors(NO_ERRORS);
      setup.mutate({ setupToken, password });
    }
  };

  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-white p-5 shadow-sm">
      <h1 className="text-xl font-semibold">{STEP_TITLES[step]}</h1>

      {step === 'token' && (
        <form onSubmit={submitToken} className="flex flex-col gap-4" noValidate>
          <p className="text-gray-600">Enter the setup token from the server's configuration (SETUP_TOKEN).</p>
          <TextField
            label="Setup token"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            error={tokenErrors.fields.setupToken}
          />
          <FormError message={tokenErrors.form} />
          <Button type="submit" block>
            Continue
          </Button>
        </form>
      )}

      {step === 'password' && (
        <form onSubmit={submitPassword} className="flex flex-col gap-4" noValidate>
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={`At least ${PASSWORD_MIN_LENGTH} characters. A few random words work well.`}
            error={passwordErrors.fields.password ?? setupErrors.fields.password}
          />
          <TextField
            label="Repeat the password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={passwordErrors.fields.confirm}
          />
          <FormError message={passwordErrors.form ?? setupErrors.form} />
          {isAlreadySetUp(setup.error) && <SignInLink />}
          <Button type="submit" mutating busy={setup.isPending} block>
            Finish setup
          </Button>
          <Button variant="ghost" onClick={() => setStep('token')}>
            Back
          </Button>
        </form>
      )}
    </section>
  );
}
