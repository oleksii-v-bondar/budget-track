import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { App } from '../app';
import { createQueryClient } from '../lib/query';
import { ToastProvider } from '../ui/toast';

/** Renders the whole app at `path` (on a memory history). Fake the API with fakeApi() first. */
export function renderApp(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  return { history, ...render(<App history={history} />) };
}

/** Renders a component with the app's query client and toasts, but no router. */
export function renderWithProviders(ui: ReactElement) {
  const queryClient = createQueryClient(() => {});
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
  return { queryClient, ...result };
}

/**
 * The API's answers for a signed-in owner with an empty history and no authenticator app (merge more routes into
 * it).
 */
export const SIGNED_IN = {
  'GET /api/auth/status': { body: { setupRequired: false, authenticated: true, authenticatorEnabled: false } },
  'GET /api/undo': { body: { undo: null, redo: null } },
};
