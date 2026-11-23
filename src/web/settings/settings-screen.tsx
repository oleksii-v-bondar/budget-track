import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useId, useState } from 'react';
import { authApi, useLeaveApp } from '../auth/auth-api';
import { errorMessage } from '../lib/commands';
import { useOnline } from '../lib/online';
import { authStatusQuery } from '../lib/query';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { ChevronRightIcon } from '../ui/icons';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';
import {
  ChangePasswordForm,
  NewRecoveryCodesForm,
  ReplaceAuthenticatorForm,
  TurnOffAuthenticatorForm,
  TurnOnAuthenticatorForm,
} from './security-forms';

type Open =
  | 'password'
  | 'turn-on-authenticator'
  | 'turn-off-authenticator'
  | 'replace-authenticator'
  | 'recovery-codes'
  | 'sign-out-everywhere'
  | null;

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="mt-6" aria-labelledby={id}>
      <h2 id={id} className="px-4 pb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase">
        {title}
      </h2>
      <div className="divide-y divide-gray-200 border-y border-gray-200">{children}</div>
    </section>
  );
}

const rowClass =
  'flex min-h-14 w-full items-center justify-between px-4 text-left text-base hover:bg-gray-50 disabled:text-gray-400';

interface RowProps {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  /** The row itself sends a request: disabled while offline. */
  mutating?: boolean;
}

function Row({ children, onClick, danger, mutating }: RowProps) {
  const online = useOnline();
  return (
    <button
      type="button"
      className={cx(rowClass, danger && 'text-red-600')}
      disabled={mutating && !online}
      onClick={onClick}
    >
      {children}
      <ChevronRightIcon className="text-gray-400" />
    </button>
  );
}

/**
 * Spec §11 Settings: password, the authenticator app (off by default: turn it on or off, replace it, new recovery
 * codes), signing out, and the JSON export.
 */
export function SettingsScreen() {
  const authenticatorEnabled = useQuery(authStatusQuery).data?.authenticatorEnabled ?? false;
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const toast = useToast();
  const leaveApp = useLeaveApp();
  const onSignOutFailed = (error: unknown) => toast.show({ tone: 'error', message: errorMessage(error) });
  const signOut = useMutation({ mutationFn: authApi.logout, onSuccess: () => leaveApp(), onError: onSignOutFailed });
  const signOutEverywhere = useMutation({
    mutationFn: authApi.logoutAll,
    onSuccess: () => leaveApp(),
    onError: onSignOutFailed,
  });

  return (
    <div className="pb-6">
      <Section title="Security">
        <Row onClick={() => setOpen('password')}>Change password</Row>
      </Section>

      <Section title="Authenticator app">
        <p className="flex min-h-14 items-center justify-between px-4 text-base">
          {authenticatorEnabled ? 'Sign-in asks for a code from the app' : 'Sign-in asks for the password only'}
          <span className="font-semibold text-gray-500">{authenticatorEnabled ? 'On' : 'Off'}</span>
        </p>
        {authenticatorEnabled ? (
          <>
            <Row onClick={() => setOpen('replace-authenticator')}>Replace authenticator app</Row>
            <Row onClick={() => setOpen('recovery-codes')}>New recovery codes</Row>
            <Row danger onClick={() => setOpen('turn-off-authenticator')}>
              Turn off
            </Row>
          </>
        ) : (
          <Row onClick={() => setOpen('turn-on-authenticator')}>Turn on</Row>
        )}
      </Section>

      <Section title="Data">
        {/* A plain download: the service worker never answers /api, so this reaches the server. */}
        <a href="/api/export" download className={rowClass}>
          Download JSON export
          <ChevronRightIcon className="text-gray-400" />
        </a>
      </Section>

      <Section title="Sessions">
        <Row mutating onClick={() => signOut.mutate()}>
          Sign out
        </Row>
        <Row danger onClick={() => setOpen('sign-out-everywhere')}>
          Sign out everywhere
        </Row>
      </Section>

      <Sheet open={open === 'password'} onClose={close} title="Change password">
        <ChangePasswordForm onDone={close} authenticatorEnabled={authenticatorEnabled} />
      </Sheet>
      <Sheet open={open === 'turn-on-authenticator'} onClose={close} title="Turn on authenticator app">
        <TurnOnAuthenticatorForm onDone={close} />
      </Sheet>
      <Sheet open={open === 'turn-off-authenticator'} onClose={close} title="Turn off authenticator app">
        <TurnOffAuthenticatorForm onDone={close} />
      </Sheet>
      <Sheet open={open === 'replace-authenticator'} onClose={close} title="Replace authenticator app">
        <ReplaceAuthenticatorForm onDone={close} />
      </Sheet>
      <Sheet open={open === 'recovery-codes'} onClose={close} title="New recovery codes">
        <NewRecoveryCodesForm onDone={close} />
      </Sheet>
      <Sheet open={open === 'sign-out-everywhere'} onClose={close} title="Sign out everywhere">
        <div className="flex flex-col gap-4">
          <p className="text-gray-600">Every device signed in to this budget, this one included, will be signed out.</p>
          <Button variant="danger" mutating busy={signOutEverywhere.isPending} block onClick={() => signOutEverywhere.mutate()}>
            Sign out everywhere
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
