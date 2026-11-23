import { queryOptions } from '@tanstack/react-query';
import { api, unwrap } from '../lib/api';

/** GET /api/accounts: every account with its balances and "≈ X zł" (spec §9, §11). */
export const accountsQuery = queryOptions({
  queryKey: ['accounts'],
  queryFn: () => unwrap(api.api.accounts.$get()),
});

/** GET /api/accounts/:id/reconcile: "Is your cleared balance X?" (spec §10). */
export const reconcileStatusQuery = (accountId: string) =>
  queryOptions({
    queryKey: ['reconcile', accountId],
    queryFn: () => unwrap(api.api.accounts[':id'].reconcile.$get({ param: { id: accountId } })),
  });
