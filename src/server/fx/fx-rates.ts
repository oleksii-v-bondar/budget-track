import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { BASE_CURRENCY } from '../../shared/api/accounts';
import { addDays, type IsoDate, weekday } from '../../engine';
import { type Clock, todayIn } from '../clock';
import type { Db } from '../db/client';
import { fxRate } from '../db/schema';
import type { Logger } from '../logger';

export interface FxQuote {
  /** NBP table A mid, a decimal string with 6 fraction digits, e.g. "4.312300" (it fits numeric(14,6)). */
  rate: string;
  /** The NBP publication day actually used (≤ the requested date, at most 7 days earlier). */
  effectiveDate: IsoDate;
}

export interface FxRates {
  /**
   * The NBP table A mid rate for `currency` on `date`: read from the fx_rate cache, otherwise fetched from NBP
   * (stepping back one day per 404, at most 7 days) and cached.
   * Returns null when the currency is PLN or unsupported, or NBP is unreachable or times out (5 s).
   * It never throws and is never called inside a DB transaction.
   */
  quote(currency: string, date: IsoDate): Promise<FxQuote | null>;
}

/** Spec §9: on a 404 (no table that day), step back one day at a time, up to 7 days. */
export const MAX_FALLBACK_DAYS = 7;
/** Spec §13: NBP never blocks a save for long. The timeout covers a whole quote, fallback steps included. */
export const NBP_TIMEOUT_MS = 5_000;

const nbpResponseSchema = z.object({
  rates: z
    .array(z.object({ effectiveDate: z.iso.date(), mid: z.number().positive().lt(1e8) }))
    .min(1),
});

export interface NbpRatesOptions {
  db: Db;
  logger: Logger;
  clock: Clock;
  timeZone: string;
  /** e.g. https://api.nbp.pl (no trailing slash). */
  baseUrl: string;
  timeoutMs?: number;
}

/**
 * A rate is final once NBP can't publish a newer one for that day: it was published on the day itself, or the day is
 * in the past or on a weekend (NBP publishes table A on working days, around noon). Only final rates are cached, so
 * today's fallback to yesterday is fetched again until today's table is out.
 */
function isFinal(date: IsoDate, quote: FxQuote, today: IsoDate): boolean {
  const day = weekday(date);
  return quote.effectiveDate === date || date < today || day === 0 || day === 6;
}

/** The fx_rate cache in front of the NBP API (spec §9). */
export function nbpRates(options: NbpRatesOptions): FxRates {
  const { db, logger, clock, timeZone, baseUrl } = options;
  const timeoutMs = options.timeoutMs ?? NBP_TIMEOUT_MS;

  async function fetchQuote(currency: string, date: IsoDate): Promise<FxQuote | null> {
    const signal = AbortSignal.timeout(timeoutMs);
    for (let back = 0; back <= MAX_FALLBACK_DAYS; back++) {
      const day = addDays(date, -back);
      const res = await fetch(`${baseUrl}/api/exchangerates/rates/A/${currency}/${day}/?format=json`, {
        headers: { accept: 'application/json' },
        signal,
      });
      if (res.status === 404) {
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) throw new Error(`NBP answered ${res.status}`);
      const [entry] = nbpResponseSchema.parse(await res.json()).rates;
      if (entry!.effectiveDate > date) throw new Error(`NBP sent a rate for ${entry!.effectiveDate}`);
      return { rate: entry!.mid.toFixed(6), effectiveDate: entry!.effectiveDate };
    }
    return null;
  }

  return {
    async quote(currency, date) {
      // Unknown codes never reach the URL; PLN is the budget currency.
      if (currency === BASE_CURRENCY || !/^[A-Z]{3}$/.test(currency)) return null;
      try {
        const [cached] = await db
          .select({ rate: fxRate.rate, effectiveDate: fxRate.effectiveDate })
          .from(fxRate)
          .where(and(eq(fxRate.currency, currency), eq(fxRate.date, date)));
        if (cached) return cached;
        const quote = await fetchQuote(currency, date);
        if (!quote) {
          logger.warn({ currency, date }, `no NBP rate within ${MAX_FALLBACK_DAYS} days`);
          return null;
        }
        if (isFinal(date, quote, todayIn(timeZone, clock.now()))) {
          await db
            .insert(fxRate)
            .values({ currency, date, rate: quote.rate, source: 'nbp', effectiveDate: quote.effectiveDate })
            .onConflictDoNothing();
        }
        return quote;
      } catch (err) {
        logger.warn({ err, currency, date }, 'NBP rate unavailable');
        return null;
      }
    },
  };
}

/**
 * Spec §9 "the latest available NBP rate" of each currency: today's quote (NBP falls back to the last published day),
 * asked once per currency and all at once. Run it before any transaction: final rates come from the cache, and each
 * NBP quote is bounded by its 5 s timeout. Currencies without a rate are left out.
 */
export async function latestRates(
  fx: FxRates,
  currencies: Iterable<string>,
  today: IsoDate,
): Promise<Map<string, FxQuote>> {
  const foreign = [...new Set(currencies)].filter((currency) => currency !== BASE_CURRENCY);
  const quotes = await Promise.all(foreign.map((currency) => fx.quote(currency, today)));
  return new Map(foreign.flatMap((currency, i) => (quotes[i] ? [[currency, quotes[i]] as const] : [])));
}
