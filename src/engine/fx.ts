import { parseDecimal, roundDiv } from './money';
import type { Money } from './types';

const RATE_SCALE = 6;
const RATE_FACTOR = 10n ** BigInt(RATE_SCALE);

/** Native amount → base currency: round(amount × rate), half away from zero. */
export function convertToBase(amount: Money, rate: string): Money {
  return Number(roundDiv(BigInt(amount) * parseDecimal(rate, RATE_SCALE), RATE_FACTOR));
}

/** Base amounts for split lines using the parent's rate; the last line absorbs rounding so the sum is `parentBase`. */
export function splitLineBases(parentBase: Money, lineAmounts: Money[], rate: string): Money[] {
  if (lineAmounts.length === 0) return [];
  const bases = lineAmounts.map((a) => convertToBase(a, rate));
  const diff = parentBase - bases.reduce((s, x) => s + x, 0);
  bases[bases.length - 1] = (bases[bases.length - 1] ?? 0) + diff;
  return bases;
}

export interface TransferSide {
  /** Native amount (source side negative, destination side positive). */
  amount: Money;
  currency: string;
  /** Required when this side's currency is not the base currency and its base amount must be converted. */
  rate: string | null;
}

/** Base amounts for both sides of a transfer; they always net to zero (spec §9). */
export function transferBases(
  baseCurrency: string,
  from: TransferSide,
  to: TransferSide,
): { fromBase: Money; toBase: Money } {
  if (from.currency === baseCurrency) return { fromBase: from.amount, toBase: -from.amount };
  if (to.currency === baseCurrency) return { fromBase: -to.amount, toBase: to.amount };
  if (!from.rate) throw new Error(`A rate is required for the ${from.currency} side of the transfer`);
  const fromBase = convertToBase(from.amount, from.rate);
  return { fromBase, toBase: -fromBase };
}

/** |base| / |native| with 6 decimals, or null when the native amount is zero. */
export function effectiveRate(nativeAmount: Money, baseAmount: Money): string | null {
  if (nativeAmount === 0) return null;
  const scaled = roundDiv(BigInt(Math.abs(baseAmount)) * RATE_FACTOR, BigInt(Math.abs(nativeAmount)));
  const int = scaled / RATE_FACTOR;
  const frac = (scaled % RATE_FACTOR).toString().padStart(RATE_SCALE, '0');
  return `${int}.${frac}`;
}

/** Unrealized FX difference: native balance at today's rate minus the base amounts already booked. */
export function revaluationDiff(nativeBalance: Money, latestRate: string, bookedBase: Money): Money {
  return convertToBase(nativeBalance, latestRate) - bookedBase;
}
