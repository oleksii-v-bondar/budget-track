import type { IsoDate } from '../../engine';
import type { FxQuote, FxRates } from '../fx/fx-rates';

export interface StubFx extends FxRates {
  /** Every quote asked for, in order. */
  calls: { currency: string; date: IsoDate }[];
}

/**
 * NBP rates for tests: `rates` maps a currency to one rate for every date, or to rates by date. Anything else
 * (and PLN) quotes null, like an unsupported currency. Rates are returned with 6 fraction digits, dated the day asked.
 */
export function stubFx(rates: Record<string, string | Record<IsoDate, string>> = {}): StubFx {
  const calls: StubFx['calls'] = [];
  return {
    calls,
    quote(currency, date) {
      calls.push({ currency, date });
      const entry = rates[currency];
      const rate = typeof entry === 'string' ? entry : entry?.[date];
      const quote: FxQuote | null =
        currency === 'PLN' || rate === undefined ? null : { rate: Number(rate).toFixed(6), effectiveDate: date };
      return Promise.resolve(quote);
    },
  };
}
