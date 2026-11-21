import { z } from 'zod';
import { BASE_CURRENCY, currencySchema } from './accounts';
import { isoDateSchema } from './common';

/** GET /api/fx/rates/:currency/:date: the NBP rate the transaction sheet pre-fills (spec §9, §11). */
export const fxRateParamSchema = z.object({
  currency: currencySchema.refine((code) => code !== BASE_CURRENCY, `${BASE_CURRENCY} is the budget currency.`),
  date: isoDateSchema,
});

/** An NBP table A mid rate. */
export interface FxRateDto {
  /** PLN per unit, 6 fraction digits, e.g. "4.312300". */
  rate: string;
  /** The NBP publication day used: the requested day, or up to 7 days earlier (weekends, holidays). */
  effectiveDate: string;
}
