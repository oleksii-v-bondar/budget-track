import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { PASSWORD_MIN_LENGTH, setupRequestSchema } from '../../shared/auth';
import { ApiError } from '../lib/api';
import { type FormErrors, formErrorsOf, NO_ERRORS, zodFormErrors } from '../lib/form-errors';
import { queryKeys } from '../lib/query';
import { Button } from '../ui/button';
import { Checkbox, FormError, TextField } from '../ui/field';
import { authApi, useEnterApp } from './auth-api';
import { RecoveryCodes } from './recovery-codes';
import { TotpQrCode, TotpSecret } from './totp-qr';

type Step = 'token' | 'password' | 'authenticator' | 'codes';

const isAlreadySetUp = (error: unknown) => error instanceof ApiError && error.code === 'already_setup';

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
  authenticator: 'Add an authenticator',
  codes: 'Save your recovery codes',
};

/**
 * First-run setup (spec §12): the setup token, a password, an authenticator app (QR code and a code from it), then the
 * ten recovery codes, shown once. Setup signs the owner in, so the last step continues into the app.
 */
export function SetupScreen() {
  const [step, setStep] = useState<Step>('token');
  const [setupToken, setSetupToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordErrors, setPasswordErrors] = useState<FormErrors>(NO_ERRORS);
  const [totpCode, setTotpCode] = useState('');
  const [saved, setSaved] = useState(false);
  const enterApp = useEnterApp();
  const queryClient = useQueryClient();
  // The cached status (never stale) still says setup is required, so the sign-in route's guard would send the owner
  // back here.
  const onError = (error: unknown) => {
    if (!isAlreadySetUp(error)) return;
    queryClient.setQueryData(queryKeys.authStatus, { setupRequired: false, authenticated: false });
  };

  const secret = useMutation({ mutationFn: authApi.setupSecret, onSuccess: () => setStep('password'), onError });
  const setup = useMutation({ mutationFn: authApi.setup, onSuccess: () => setStep('codes'), onError });
  const tokenErrors = formErrorsOf(secret.error, ['setupToken']);
  const setupErrors = formErrorsOf(setup.error, ['totpCode']);

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    secret.mutate(setupToken);
  };
  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    // The server checks the password only at the end; the shared schema finds a weak one now.
    const checked = setupRequestSchema.pick({ password: true }).safeParse({ password });
    if (!checked.success) setPasswordErrors(zodFormErrors(checked.error, ['password']));
    else if (confirm !== password) setPasswordErrors({ fields: { confirm: "The passwords don't match." }, form: null });
    else {
      setPasswordErrors(NO_ERRORS);
      setStep('authenticator');
    }
  };
  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (secret.data) setup.mutate({ setupToken, password, totpSecret: secret.data.secret, totpCode });
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
          {isAlreadySetUp(secret.error) && <SignInLink />}
          <Button type="submit" mutating busy={secret.isPending} block>
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
            error={passwordErrors.fields.password}
          />
          <TextField
            label="Repeat the password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={passwordErrors.fields.confirm}
          />
          <FormError message={passwordErrors.form} />
          <Button type="submit" block>
            Continue
          </Button>
        </form>
      )}

      {step === 'authenticator' && secret.data && (
        <form onSubmit={submitCode} className="flex flex-col gap-4" noValidate>
          <p className="text-gray-600">
            Scan this code with an authenticator app (such as Google Authenticator or 1Password), then enter the 6-digit
            code it shows.
          </p>
          <TotpQrCode uri={secret.data.uri} />
          <TotpSecret secret={secret.data.secret} />
          <TextField
            label="Code from the app"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
            error={setupErrors.fields.totpCode}
          />
          <FormError message={setupErrors.form} />
          {isAlreadySetUp(setup.error) && <SignInLink />}
          <Button type="submit" mutating busy={setup.isPending} block>
            Finish setup
          </Button>
          <Button variant="ghost" onClick={() => setStep('password')}>
            Back
          </Button>
        </form>
      )}

      {step === 'codes' && setup.data && (
        <div className="flex flex-col gap-4">
          <p className="text-gray-600">
            If you lose your phone, sign in with one of these codes instead of an authenticator code. Each works once,
            and they won't be shown again.
          </p>
          <RecoveryCodes codes={setup.data.recoveryCodes} />
          <Checkbox label="I've saved my recovery codes" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <Button block disabled={!saved} onClick={() => enterApp()}>
            Continue to the budget
          </Button>
        </div>
      )}
    </section>
  );
}
