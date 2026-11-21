import { type ErrorComponentProps, Link, useRouter } from '@tanstack/react-router';
import { errorMessage } from '../lib/commands';
import { Button } from '../ui/button';
import { ChevronRightIcon } from '../ui/icons';

/** Stands in for a screen a later phase builds (P3b: Budget; P3c: Accounts, transactions, Scheduled, Payees). */
export function PlaceholderScreen({ name }: { name: string }) {
  return (
    <div className="px-4 py-12 text-center text-gray-500">
      <p className="font-medium text-gray-700">{name}</p>
      <p>This screen isn't built yet.</p>
    </div>
  );
}

/** Spec §11: More holds Scheduled, Payees and Settings. */
export function MoreScreen() {
  const items = [
    { to: '/scheduled', label: 'Scheduled' },
    { to: '/payees', label: 'Payees' },
    { to: '/settings', label: 'Settings' },
  ] as const;
  return (
    <ul className="divide-y divide-gray-200">
      {items.map((item) => (
        <li key={item.to}>
          <Link to={item.to} className="flex min-h-14 items-center justify-between px-4 text-base hover:bg-gray-50">
            {item.label}
            <ChevronRightIcon className="text-gray-400" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function NotFoundScreen() {
  return (
    <div className="mx-auto max-w-[480px] px-4 py-12 text-center">
      <p className="text-lg font-semibold">Page not found</p>
      <Link to="/budget" className="text-brand underline">
        Go to the budget
      </Link>
    </div>
  );
}

/** A route failed to load (e.g. the sign-in check couldn't reach the server): Try again runs its checks again. */
export function ErrorScreen({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div className="mx-auto flex max-w-[480px] flex-col items-center gap-4 px-4 py-12 text-center">
      <h1 className="text-lg font-semibold">This page didn't load</h1>
      <p className="text-gray-600">{errorMessage(error)}</p>
      <Button onClick={() => void router.invalidate()}>Try again</Button>
    </div>
  );
}
