import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { authStatusQuery } from './lib/query';
import { AppShell, AuthLayout } from './shell/app-shell';
import { OfflineBanner } from './shell/offline-banner';
import { MoreScreen, NotFoundScreen, PlaceholderScreen } from './shell/screens';

export interface RouterContext {
  queryClient: QueryClient;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
  interface StaticDataRouteOption {
    /** Shown in the app shell's header. */
    title?: string;
  }
}

/** A path to return to after signing in: only paths of this app, and never the sign-in pages themselves. */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\/(?![/\\])/.test(value)) return undefined;
  return /^\/(login|setup)(?=[/?#]|$)/.test(value) ? undefined : value;
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

// Setup and sign-in. The guards read the cached auth status, which setup, sign-in, sign-out and any 401 keep current.
const authLayout = createRoute({ getParentRoute: () => rootRoute, id: 'auth', component: AuthLayout });

const setupRoute = createRoute({
  getParentRoute: () => authLayout,
  path: 'setup',
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (!status.setupRequired) throw redirect({ to: status.authenticated ? '/budget' : '/login' });
  },
  component: () => <PlaceholderScreen name="Set up" />,
});

const loginRoute = createRoute({
  getParentRoute: () => authLayout,
  path: 'login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const target = safeRedirect(search.redirect);
    return target === undefined ? {} : { redirect: target };
  },
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (status.setupRequired) throw redirect({ to: '/setup' });
    if (status.authenticated) throw redirect({ to: '/budget' });
  },
  component: () => <PlaceholderScreen name="Sign in" />,
});

// Everything else needs a session and lives in the app shell. A later phase adds its screens here.
const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (status.setupRequired) throw redirect({ to: '/setup' });
    if (!status.authenticated) throw redirect({ to: '/login', search: { redirect: safeRedirect(location.href) } });
  },
  component: AppShell,
});

const appRoutes = [
  createRoute({
    getParentRoute: () => appLayout,
    path: '/',
    beforeLoad: () => {
      throw redirect({ to: '/budget' });
    },
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'budget',
    staticData: { title: 'Budget' },
    component: () => <PlaceholderScreen name="Budget" />,
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'accounts',
    staticData: { title: 'Accounts' },
    component: () => <PlaceholderScreen name="Accounts" />,
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'transactions/new',
    staticData: { title: 'New transaction' },
    component: () => <PlaceholderScreen name="New transaction" />,
  }),
  createRoute({ getParentRoute: () => appLayout, path: 'more', staticData: { title: 'More' }, component: MoreScreen }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'scheduled',
    staticData: { title: 'Scheduled' },
    component: () => <PlaceholderScreen name="Scheduled" />,
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'payees',
    staticData: { title: 'Payees' },
    component: () => <PlaceholderScreen name="Payees" />,
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: 'settings',
    staticData: { title: 'Settings' },
    component: () => <PlaceholderScreen name="Settings" />,
  }),
] as const;

const routeTree = rootRoute.addChildren([
  authLayout.addChildren([setupRoute, loginRoute]),
  appLayout.addChildren(appRoutes),
]);

/** The app's router; tests pass a memory history. */
export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({ routeTree, context: { queryClient }, history });
}
