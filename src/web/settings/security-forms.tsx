import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { PASSWORD_MIN_LENGTH } from '../../shared/auth';
import { authApi } from '../auth/auth-api';
import { RecoveryCodes } from '../auth/recovery-codes';
import { TotpQrCode, TotpSecret } from '../auth/totp-qr';
import { formErrorsOf } from '../lib/form-errors';
import { Button } from '../ui/button';
import { FormError, SegmentedControl, TextField } from '../ui/field';
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

/** Spec §12: a new password needs the current one and an authenticator code; other devices are signed out. */
export function ChangePasswordForm({ onDone }: FormProps) {
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
    if (confirm === newPassword) change.mutate({ currentPassword, newPassword, totpCode });
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
      <CodeField label="Authenticator code" value={totpCode} onChange={setTotpCode} error={errors.fields.totpCode} />
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={change.isPending} block>
        Change password
      </Button>
    </form>
  );
}

type Factor = 'totp' | 'recovery';

/**
 * Spec §12: switching authenticators needs the password plus the current authenticator code or a recovery code (for
 * a lost phone), and a code from the new authenticator. Other devices are signed out.
 */
export function ChangeAuthenticatorForm({ onDone }: FormProps) {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [factor, setFactor] = useState<Factor>('totp');
  const [currentCode, setCurrentCode] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const secret = useMutation({ mutationFn: authApi.newTotpSecret });
  const confirm = useMutation({
    mutationFn: authApi.confirmTotp,
    onSuccess: () => {
      toast.show({ message: 'Authenticator changed. Other devices were signed out.' });
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
      <SegmentedControl
        label="Confirm with"
        value={factor}
        options={[
          { value: 'totp', label: 'Current app' },
          { value: 'recovery', label: 'Recovery code' },
        ]}
        onChange={(value) => {
          setFactor(value);
          setCurrentCode('');
        }}
      />
      {factor === 'totp' ? (
        <CodeField
          label="Code from the current app"
          value={currentCode}
          onChange={setCurrentCode}
          error={errors.fields.currentTotpCode}
        />
      ) : (
        <TextField
          label="Recovery code"
          autoComplete="off"
          spellCheck={false}
          value={currentCode}
          onChange={(e) => setCurrentCode(e.target.value)}
          error={errors.fields.recoveryCode}
        />
      )}
      <FormError message={errors.form} />
      <Button type="submit" mutating busy={confirm.isPending} block>
        Switch authenticator
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
