import { queryOptions } from '@tanstack/react-query';
import { api, unwrap } from './api';

/**
 * GET /api/fx/rates/:currency/:date: the NBP rate a form suggests (spec §9). The server answers 422
 * `fx_rate_unavailable` when NBP has none (or the date is ahead), so the form asks for a rate instead.
 */
export const fxRateQuery = (currency: string, date: string) =>
  queryOptions({
    queryKey: ['fx', currency, date],
    queryFn: () => unwrap(api.api.fx.rates[':currency'][':date'].$get({ param: { currency, date } })),
    staleTime: Infinity,
    retry: false,
  });

/** "4,3123" for "4.312300": a decimal comma, trailing zeros dropped (at least two decimals kept). */
export function formatRate(rate: string): string {
  const [whole, fraction = ''] = rate.split('.');
  return `${whole},${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

/** What a rate field holds, as the API takes it: "4,31" → "4.31". */
export function rateInput(text: string): string {
  return text.trim().replace(',', '.');
}
