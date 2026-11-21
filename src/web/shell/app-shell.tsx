import { Outlet, useMatches } from '@tanstack/react-router';
import { BottomNav } from './bottom-nav';
import { UndoRedoButtons } from './undo-redo';

/** The signed-in phone layout (spec §11): header with the screen's title and Undo/Redo, the screen, bottom nav. */
export function AppShell() {
  // The deepest route with a title names the screen.
  const title = useMatches({
    select: (matches) => matches.reduce<string | undefined>((found, match) => match.staticData.title ?? found, undefined),
  });
  return (
    <div className="mx-auto flex min-h-dvh max-w-[480px] flex-col bg-white shadow-sm">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-gray-200 bg-white px-4 pt-[env(safe-area-inset-top)]">
        <h1 className="py-3 text-lg font-semibold">{title}</h1>
        <UndoRedoButtons />
      </header>
      <main className="flex-1 pb-24">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}

/** Setup and sign-in: one centred column without navigation. */
export function AuthLayout() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[480px] flex-col justify-center gap-6 px-4 py-8">
      <p className="text-center text-2xl font-bold text-brand">Budget Track</p>
      <Outlet />
    </main>
  );
}
