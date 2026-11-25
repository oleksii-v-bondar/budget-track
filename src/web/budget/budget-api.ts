import { queryOptions } from '@tanstack/react-query';
import { api, unwrap } from '../lib/api';

/** GET /api/budget/:month: the whole Budget screen for one month (spec §11), under the query key ['budget', month]. */
export const budgetMonthQuery = (month: string) =>
  queryOptions({
    queryKey: ['budget', month],
    queryFn: () => unwrap(api.api.budget[':month'].$get({ param: { month } })),
  });

/** GET /api/budget/settings: the expected monthly income the Edit Plan compares the month's targets with. */
export const budgetSettingsQuery = queryOptions({
  queryKey: ['budget-settings'],
  queryFn: () => unwrap(api.api.budget.settings.$get()),
});
