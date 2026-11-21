import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useState } from 'react';
import { createQueryClient, forgetSession } from './lib/query';
import { createAppRouter } from './router';
import { ToastProvider } from './ui/toast';

/** The whole web app: data cache, toasts and routes. `history` is for tests (a memory history). */
export function App({ history }: { history?: RouterHistory }) {
  const [{ queryClient, router }] = useState(() => {
    // A 401 from any request means the session ended (expired, or signed out elsewhere): go and sign in again.
    const client = createQueryClient(() => {
      forgetSession(client);
      const { pathname, href } = appRouter.state.location;
      if (pathname !== '/login') void appRouter.navigate({ to: '/login', search: { redirect: href } });
    });
    const appRouter = createAppRouter(client, history);
    return { queryClient: client, router: appRouter };
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
