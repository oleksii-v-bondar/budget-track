import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { useState } from 'react';
import { AccountsScreen } from './accounts/accounts-screen';
import { LoginScreen } from './auth/login-screen';
import { BudgetScreen } from './budget/budget-screen';
import { HomeScreen } from './home/home-screen';
import { thisMonth } from './lib/format';
import { authStatusQuery } from './lib/query';
import { filtersFromSearch } from './register/filters';
import { ReflectScreen } from './reflect/reflect-screen';
import { RegisterScreen } from './register/register-screen';
import { SettingsScreen } from './settings/settings-screen';
import { AppShell, AuthLayout } from './shell/app-shell';
import { OfflineBanner } from './shell/offline-banner';
import { ErrorScreen, NotFoundScreen } from './shell/screens';
import { NewTransactionScreen, prefillFromSearch } from './transactions/new-transaction-screen';

export interface RouterContext {
  queryClient: QueryClient;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

/** A path to return to after signing in: only paths of this app, and never the sign-in page itself. */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\/(?![/\\])/.test(value)) return undefined;
  return /^\/login(?=[/?#]|$)/.test(value) ? undefined : value;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <>
      <OfflineBanner />
      <Outlet />
    </>
  ),
  notFoundComponent: NotFoundScreen,
});

// Sign-in. The guards read the cached auth status, which sign-in, sign-out and any 401 keep current.
const authLayout = createRoute({ getParentRoute: () => rootRoute, id: 'auth', component: AuthLayout });

const loginRoute = createRoute({
  getParentRoute: () => authLayout,
  path: 'login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const target = safeRedirect(search.redirect);
    return target === undefined ? {} : { redirect: target };
  },
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (status.authenticated) throw redirect({ to: '/home' });
  },
  component: LoginScreen,
});

// Everything else needs a session and lives in the app shell.
const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (!status.authenticated) throw redirect({ to: '/login', search: { redirect: safeRedirect(location.href) } });
  },
  component: AppShell,
});

function AccountRegister() {
  const { accountId = '' } = useParams({ strict: false });
  const filters = filtersFromSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  return (
    <RegisterScreen
      key={accountId}
      accountId={accountId}
      filters={filters}
      onFiltersChange={(search) => void navigate({ to: '/accounts/$accountId', params: { accountId }, search })}
    />
  );
}

function AllAccountsRegister() {
  const filters = filtersFromSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  return <RegisterScreen filters={filters} onFiltersChange={(search) => void navigate({ to: '/transactions', search })} />;
}

/** `/budget?month=YYYY-MM`; without a (valid) month it shows this device's current month. */
const budgetRoute = createRoute({
  getParentRoute: () => appLayout,
  path: 'budget',
  validateSearch: (search: Record<string, unknown>): { month?: string } =>
    typeof search.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(search.month) ? { month: search.month } : {},
  component: BudgetRoute,
});

function BudgetRoute() {
  const { month } = useSearch({ strict: false });
  const [today] = useState(thisMonth);
  return <BudgetScreen month={month ?? today} />;
}

const appRoutes = [
  createRoute({
    getParentRoute: () => appLayout,
    path: '/',
    beforeLoad: () => {
      throw redirect({ to: '/home' });
    },
  }),
  createRoute({ getParentRoute: () => appLayout, path: 'home', component: HomeScreen }),
  budgetRoute,
  createRoute({
    getParentRoute: () => appLayout,
    path: 'accounts',
    component: AccountsScreen,
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'accounts/$accountId',
    validateSearch: filtersFromSearch,
    component: AccountRegister,
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'transactions',
    validateSearch: filtersFromSearch,
    component: AllAccountsRegister,
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'transactions/new',
    validateSearch: prefillFromSearch,
    component: NewTransactionScreen,
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'settings',
    // ?bank=error: the bank's consent flow failed (see /api/bank/callback).
    validateSearch: (search: Record<string, unknown>): { bank?: 'error' } =>
      search.bank === 'error' ? { bank: 'error' } : {},
    component: SettingsScreen,
  }),
  createRoute({ getParentRoute: () => appLayout, path: 'reflect', component: ReflectScreen }),
] as const;

const routeTree = rootRoute.addChildren([
  authLayout.addChildren([loginRoute]),
  appLayout.addChildren(appRoutes),
]);

/** The app's router; tests pass a memory history. */
export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({ routeTree, context: { queryClient }, history, defaultErrorComponent: ErrorScreen });
}
