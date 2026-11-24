import { Outlet } from '@tanstack/react-router';
import { BottomNav } from './bottom-nav';
import { NewTransactionButton } from './new-transaction-button';

/** The signed-in phone layout (spec §11): the screen (with its own top bar), "+ Transaction" and the tab bar. */
export function AppShell() {
  return (
    <div className="mx-auto min-h-dvh max-w-[480px]">
      <main className="pb-[calc(10rem+env(safe-area-inset-bottom))]">
        <Outlet />
      </main>
      <NewTransactionButton />
      <BottomNav />
    </div>
  );
}

/** Sign-in: one centred column without navigation. */
export function AuthLayout() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[480px] flex-col justify-center gap-6 px-4 py-8">
      <p className="text-center text-3xl font-bold text-lime">Budget Track</p>
      <Outlet />
    </main>
  );
}
