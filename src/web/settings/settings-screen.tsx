import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { authApi, useLeaveApp } from '../auth/auth-api';
import { errorMessage } from '../lib/commands';
import { useOnline } from '../lib/online';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { ChevronRightIcon } from '../ui/icons';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';
import { ChangeAuthenticatorForm, ChangePasswordForm, NewRecoveryCodesForm } from './security-forms';

type Open = 'password' | 'authenticator' | 'recovery-codes' | 'sign-out-everywhere' | null;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="px-4 pb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase">{title}</h2>
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

/** Spec §11 Settings: password, authenticator, recovery codes, signing out, and the JSON export. */
export function SettingsScreen() {
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
        <Row onClick={() => setOpen('authenticator')}>Change authenticator app</Row>
        <Row onClick={() => setOpen('recovery-codes')}>New recovery codes</Row>
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
        <ChangePasswordForm onDone={close} />
      </Sheet>
      <Sheet open={open === 'authenticator'} onClose={close} title="Change authenticator app">
        <ChangeAuthenticatorForm onDone={close} />
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
