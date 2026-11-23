import { queryOptions } from '@tanstack/react-query';
import { api, unwrap } from '../lib/api';

/** GET /api/budget/:month: the whole Budget screen for one month (spec §11), under the query key ['budget', month]. */
export const budgetMonthQuery = (month: string) =>
  queryOptions({
    queryKey: ['budget', month],
    queryFn: () => unwrap(api.api.budget[':month'].$get({ param: { month } })),
  });
