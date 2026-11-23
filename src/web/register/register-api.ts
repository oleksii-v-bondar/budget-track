import { infiniteQueryOptions } from '@tanstack/react-query';
import type { z } from 'zod';
import type { registerQuerySchema } from '../../shared/api/transactions';
import { api, unwrap } from '../lib/api';

/** GET /api/transactions filters as the query string carries them (every value a string). */
export type RegisterParams = Omit<z.input<typeof registerQuerySchema>, 'cursor' | 'limit'>;

/**
 * The register (spec §10 "Search and bulk operations"): pages of transactions, newest first, under
 * `['transactions', 'register', params]`; each page asks for the rows after the previous page's `nextCursor`.
 */
export const registerQuery = (params: RegisterParams) =>
  infiniteQueryOptions({
    queryKey: ['transactions', 'register', params],
    queryFn: ({ pageParam }) =>
      unwrap(api.api.transactions.$get({ query: pageParam === null ? params : { ...params, cursor: pageParam } })),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
