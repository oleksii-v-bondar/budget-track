import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { App } from '../app';
import { createQueryClient } from '../lib/query';
import { ToastProvider } from '../ui/toast';
import { budgetMonth, monthOfPath } from './budget-fixtures';
import type { FakeRequest } from './fake-api';

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

/** The API's answers for a signed-in owner with an empty budget and history (merge more routes into it). */
export const SIGNED_IN = {
  'GET /api/auth/status': { body: { authenticated: true } },
  'GET /api/undo': { body: { undo: null, redo: null } },
  'GET /api/budget/:month': (request: FakeRequest) => ({ body: budgetMonth({ month: monthOfPath(request.path) }) }),
  'GET /api/budget/settings': { body: { expectedMonthlyIncome: null } },
};
