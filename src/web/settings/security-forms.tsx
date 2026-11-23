import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { currentPasswordSchema, PASSWORD_MIN_LENGTH } from '../../shared/auth';
import { authApi } from '../auth/auth-api';
import { RecoveryCodes } from '../auth/recovery-codes';
import { TotpQrCode, TotpSecret } from '../auth/totp-qr';
import { ApiError } from '../lib/api';
import { formErrorsOf } from '../lib/form-errors';
import { setAuthStatus } from '../lib/query';
import { Button } from '../ui/button';
import { Checkbox, FormError, SegmentedControl, TextField } from '../ui/field';
import { useToast } from '../ui/toast';

/** Each form below runs inside a Sheet, which unmounts it on close, so every opening starts empty. */
interface FormProps {
  onDone: () => void;
}

const sixDigits = (value: string) => value.replace(/\D/g, '').slice(0, 6);

function CodeField(props: { label: string; value: string; onChange: (value: string) => void; error?: string }) {
  return (
    <TextField
      label={props.label}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      value={props.value}
      onChange={(e) => props.onChange(sixDigits(e.target.value))}
      error={props.error}
    />
  );
}

function CurrentPasswordField(props: { value: string; onChange: (value: string) => void; error?: string }) {
  return (
    <TextField
      label="Current password"
      type="password"
      autoComplete="current-password"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      error={props.error}
    />
  );
}

type Factor = 'totp' | 'recovery';

/** The current authenticator code, or a recovery code instead (for a lost phone). */
function CurrentFactorFields(props: {
  factor: Factor;
  onFactorChange: (factor: Factor) => void;
  code: string;
  onCodeChange: (code: string) => void;
  totpLabel: string;
  errors: Record<string, string>;
  totpField: string;
}) {
  return (
    <>
      <SegmentedControl
        label="Confirm with"
        value={props.factor}
        options={[
          { value: 'totp', label: 'Current app' },
          { value: 'recovery', label: 'Recovery code' },
        ]}
        onChange={(value) => {
          props.onFactorChange(value);
          props.onCodeChange('');
        }}
      />
      {props.factor === 'totp' ? (
        <CodeField
          label={props.totpLabel}
          value={props.code}
          onChange={props.onCodeChange}
          error={props.errors[props.totpField]}
        />
      ) : (
        <TextField
          label="Recovery code"
          autoComplete="off"
          spellCheck={false}
          value={props.code}
          onChange={(e) => props.onCodeChange(e.target.value)}
          error={props.errors.recoveryCode}
        />
      )}
    </>
  );
}

/**
 * Spec §12: a new password needs the current one, plus an authenticator code while one is on; other devices are
 * signed out.
 */
export function ChangePasswordForm({ onDone, authenticatorEnabled }: FormProps & { authenticatorEnabled: boolean }) {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const change = useMutation({
    mutationFn: authApi.changePassword,
    onSuccess: () => {
      toast.show({ message: 'Password changed. Other devices were signed out.' });
      onDone();
    },
  });
  const errors = formErrorsOf(change.error, ['currentPassword', 'newPassword', 'totpCode']);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setMismatch(confirm !== newPassword);
    if (confirm !== newPassword) return;
    change.mutate(authenticatorEnabled ? { currentPassword, newPassword, totpCode } : { currentPassword, newPassword });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <CurrentPasswordField value={currentPassword} onChange={setCurrentPassword} error={errors.fields.currentPassword} />
      <TextField
        label="New password"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        error={errors.fields.newPassword}
      />
      <TextField
        label="Repeat the new password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={mismatch ? "The passwords don't match." : undefined}
      />
      {authenticatorEnabled && (
        <CodeField label="Authenticator code" value={totpCode} onChange={setTotpCode} error={errors.fields.totpCode} />
      )}
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={change.isPending} block>
        Change password
      </Button>
    </form>
  );
}

type TurnOnStep = 'password' | 'scan';

/**
 * Turns the authenticator app on: the current password, then a new secret as a QR code (and as text), a code from the
 * app to confirm it, and the ten recovery codes, shown once. Other devices are signed out.
 */
export function TurnOnAuthenticatorForm({ onDone }: FormProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<TurnOnStep>('password');
  const [currentPassword, setCurrentPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string>();
  const [totpCode, setTotpCode] = useState('');
  const [saved, setSaved] = useState(false);
  const secret = useMutation({ mutationFn: authApi.newTotpSecret, onSuccess: () => setStep('scan') });
  const confirm = useMutation({
    mutationFn: authApi.confirmTotp,
    onSuccess: () => {
      setAuthStatus(queryClient, { authenticatorEnabled: true });
      toast.show({ message: 'Authenticator app turned on. Other devices were signed out.' });
    },
    // The password is checked only now, so a wrong one brings back its step.
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'invalid_credentials') setStep('password');
    },
  });
  const passwordErrors = formErrorsOf(confirm.error ?? secret.error, ['currentPassword']);
  const scanErrors = formErrorsOf(confirm.error, ['totpCode']);

  if (confirm.data?.recoveryCodes) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-gray-600">
          If you lose your phone, sign in with one of these codes instead of an authenticator code. Each works once, and
          they won't be shown again.
        </p>
        <RecoveryCodes codes={confirm.data.recoveryCodes} />
        <Checkbox label="I've saved my recovery codes" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <Button block disabled={!saved} onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }

  if (step === 'password' || !secret.data) {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      const checked = currentPasswordSchema.safeParse(currentPassword);
      setPasswordError(checked.success ? undefined : checked.error.issues[0]?.message);
      if (!checked.success) return;
      confirm.reset();
      // A secret already shown is kept, so the app entry scanned with it still works.
      if (secret.data) setStep('scan');
      else secret.mutate();
    };
    return (
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <p className="text-gray-600">
          Sign-in will then ask for a code from an authenticator app (such as Google Authenticator or 1Password) as well
          as your password. Other devices are signed out.
        </p>
        <CurrentPasswordField
          value={currentPassword}
          onChange={setCurrentPassword}
          error={passwordError ?? passwordErrors.fields.currentPassword}
        />
        <FormError message={passwordErrors.form} />
        <Button type="submit" mutating busy={secret.isPending} block>
          Continue
        </Button>
      </form>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    confirm.mutate({ currentPassword, totpSecret: secret.data.secret, totpCode });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <p className="text-gray-600">Scan this code with your authenticator app, then enter the 6-digit code it shows.</p>
      <TotpQrCode uri={secret.data.uri} />
      <TotpSecret secret={secret.data.secret} />
      <CodeField label="Code from the app" value={totpCode} onChange={setTotpCode} error={scanErrors.fields.totpCode} />
      <FormError message={scanErrors.form} />
      <Button type="submit" mutating busy={confirm.isPending} block>
        Turn on
      </Button>
      <Button variant="ghost" onClick={() => setStep('password')}>
        Back
      </Button>
    </form>
  );
}

/**
 * Turns the authenticator app off: the password and the current code or a recovery code, confirmed with a checkbox.
 * Sign-in then takes the password only, the recovery codes stop working, and other devices are signed out.
 */
export function TurnOffAuthenticatorForm({ onDone }: FormProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [factor, setFactor] = useState<Factor>('totp');
  const [code, setCode] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const disable = useMutation({
    mutationFn: authApi.disableTotp,
    onSuccess: () => {
      setAuthStatus(queryClient, { authenticatorEnabled: false });
      toast.show({ message: 'Authenticator app turned off. Other devices were signed out.' });
      onDone();
    },
  });
  const errors = formErrorsOf(disable.error, ['currentPassword', 'totpCode', 'recoveryCode']);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!confirmed) return;
    disable.mutate(factor === 'totp' ? { currentPassword, totpCode: code } : { currentPassword, recoveryCode: code });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <p className="text-gray-600">
        Sign-in will ask for your password only. Your recovery codes stop working, and other devices are signed out.
      </p>
      <CurrentPasswordField value={currentPassword} onChange={setCurrentPassword} error={errors.fields.currentPassword} />
      <CurrentFactorFields
        factor={factor}
        onFactorChange={setFactor}
        code={code}
        onCodeChange={setCode}
        totpLabel="Authenticator code"
        totpField="totpCode"
        errors={errors.fields}
      />
      <Checkbox
        label="Sign in with the password only from now on"
        checked={confirmed}
        onChange={(e) => setConfirmed(e.target.checked)}
      />
      <FormError message={errors.form} />
      <Button type="submit" variant="danger" mutating busy={disable.isPending} disabled={!confirmed} block>
        Turn off
      </Button>
    </form>
  );
}

/**
 * Spec §12: replacing the authenticator app needs the password plus the current authenticator code or a recovery code
 * (for a lost phone), and a code from the new authenticator. The recovery codes stay; other devices are signed out.
 */
export function ReplaceAuthenticatorForm({ onDone }: FormProps) {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [factor, setFactor] = useState<Factor>('totp');
  const [currentCode, setCurrentCode] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const secret = useMutation({ mutationFn: authApi.newTotpSecret });
  const confirm = useMutation({
    mutationFn: authApi.confirmTotp,
    onSuccess: () => {
      toast.show({ message: 'Authenticator replaced. Other devices were signed out.' });
      onDone();
    },
  });
  const errors = formErrorsOf(confirm.error ?? secret.error, ['currentPassword', 'currentTotpCode', 'recoveryCode', 'totpCode']);

  if (!secret.data) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-gray-600">
          You'll scan a new QR code with your authenticator app. The old entry stops working, and other devices are
          signed out.
        </p>
        <FormError message={errors.form} />
        <Button mutating busy={secret.isPending} block onClick={() => secret.mutate()}>
          Show the new QR code
        </Button>
      </div>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const current = factor === 'totp' ? { currentTotpCode: currentCode } : { recoveryCode: currentCode };
    confirm.mutate({ currentPassword, ...current, totpSecret: secret.data.secret, totpCode });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <TotpQrCode uri={secret.data.uri} />
      <TotpSecret secret={secret.data.secret} />
      <CodeField label="Code from the new app" value={totpCode} onChange={setTotpCode} error={errors.fields.totpCode} />
      <CurrentPasswordField value={currentPassword} onChange={setCurrentPassword} error={errors.fields.currentPassword} />
      <CurrentFactorFields
        factor={factor}
        onFactorChange={setFactor}
        code={currentCode}
        onCodeChange={setCurrentCode}
        totpLabel="Code from the current app"
        totpField="currentTotpCode"
        errors={errors.fields}
      />
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={confirm.isPending} block>
        Replace authenticator
      </Button>
    </form>
  );
}

/** Spec §12: a new set of ten recovery codes replaces the old ones; they are shown once. */
export function NewRecoveryCodesForm({ onDone }: FormProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const create = useMutation({ mutationFn: authApi.newRecoveryCodes });
  const errors = formErrorsOf(create.error, ['currentPassword', 'totpCode']);
  if (create.data) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-gray-600">Your old recovery codes no longer work. Save these; they won't be shown again.</p>
        <RecoveryCodes codes={create.data.recoveryCodes} />
        <Button block onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ currentPassword, totpCode });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <p className="text-gray-600">The new codes replace all the old ones, used or not.</p>
      <CurrentPasswordField value={currentPassword} onChange={setCurrentPassword} error={errors.fields.currentPassword} />
      <CodeField label="Authenticator code" value={totpCode} onChange={setTotpCode} error={errors.fields.totpCode} />
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={create.isPending} block>
        Make new codes
      </Button>
    </form>
  );
}
