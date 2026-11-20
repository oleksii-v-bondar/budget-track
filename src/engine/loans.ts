import { addMonths } from './dates';
import { assertMoney, ceilDiv, parseDecimal, roundDiv } from './money';
import type { Money, Month } from './types';

const APR_SCALE = 4;
const MONTHLY_APR_DIVISOR = 12n * 100n * 10n ** BigInt(APR_SCALE);
const MAX_PAYOFF_MONTHS = 1200;

/** Parses a percentage APR such as "6.5" at scale 4; a negative APR is rejected. */
function parseApr(apr: string): bigint {
  const scaled = parseDecimal(apr, APR_SCALE);
  if (scaled < 0n) throw new Error(`APR must be ≥ 0, got "${apr}"`);
  return scaled;
}

function interestAt(balance: Money, scaledApr: bigint): Money {
  return Number(roundDiv(BigInt(Math.abs(balance)) * scaledApr, MONTHLY_APR_DIVISOR));
}

/**
 * Interest for one month: |balance| × APR / 12, rounded half away from zero, so ≥ 0 whatever the balance's sign.
 * `apr` is a percentage, e.g. "6.5".
 */
export function monthlyInterest(balance: Money, apr: string): Money {
  return interestAt(balance, parseApr(apr));
}

/** Number of monthly payments needed to clear `debt` (0 if nothing is owed), or null if it never clears. */
function paymentsToPayoff(debt: Money, scaledApr: bigint, payment: Money, escrow: Money): number | null {
  let remaining = Math.abs(debt);
  if (remaining === 0) return 0;
  for (let i = 1; i <= MAX_PAYOFF_MONTHS; i++) {
    const principal = payment - escrow - interestAt(remaining, scaledApr);
    if (principal <= 0) return null;
    remaining -= principal;
    if (remaining <= 0) return i;
  }
  return null;
}

/**
 * Smallest whole-grosz monthly payment that clears `principal` (≥ 0) at `apr` within `months` (an integer ≥ 1)
 * payments, using the same per-month rounded interest as `projectPayoff` (no escrow). Starts from the annuity
 * estimate and adjusts it by single grosz. Because `projectPayoff` gives up after 1200 months, longer terms are
 * treated as 1200 months.
 */
export function amortizedPayment(principal: Money, apr: string, months: number): Money {
  if (!Number.isInteger(months) || months < 1) {
    throw new Error(`amortizedPayment: months must be an integer ≥ 1, got ${months}`);
  }
  const scaledApr = parseApr(apr);
  if (principal <= 0) return 0;
  const horizon = Math.min(months, MAX_PAYOFF_MONTHS);
  const rate = Number(scaledApr) / Number(MONTHLY_APR_DIVISOR);
  let payment =
    rate === 0 ? ceilDiv(principal, horizon) : Math.ceil((rate * principal) / (1 - (1 + rate) ** -horizon));
  const fits = (p: Money) => {
    const count = paymentsToPayoff(principal, scaledApr, p, 0);
    return count !== null && count <= horizon;
  };
  // A payment of principal + one month's interest always clears the debt in one payment.
  const upperBound = principal + interestAt(principal, scaledApr);
  while (payment > 1 && fits(payment - 1)) payment -= 1;
  while (payment < upperBound && !fits(payment)) payment += 1;
  return payment;
}

export interface LoanParams {
  apr: string;
  /** ≥ 0; charged in months with a payment. */
  escrow: Money;
  interestOverrides?: Record<Month, Money>;
}

export interface LoanMonthInput {
  month: Month;
  /** Σ native amounts of the loan account's transactions in the month (debt is negative). */
  transactionsTotal: Money;
  /** Σ inflows (payments) to the loan account in the month; ≥ 0. The month has a payment iff this is > 0. */
  paymentsTotal: Money;
}

export interface LoanMonth {
  month: Month;
  startBalance: Money;
  transactionsTotal: Money;
  interest: Money;
  escrow: Money;
  endBalance: Money;
  principalPaid: Money;
}

/**
 * Rolls a loan account forward month by month (ascending; months without transactions may be omitted).
 * Interest and escrow are charged only in months with a payment; principal paid = payments − interest − escrow.
 * Balances are negative while money is owed; interest and escrow are ≥ 0 and lower the balance.
 */
export function computeLoanMonths(params: LoanParams, months: LoanMonthInput[]): LoanMonth[] {
  const scaledApr = parseApr(params.apr);
  assertMoney(params.escrow, 'escrow');
  for (const [month, interest] of Object.entries(params.interestOverrides ?? {})) {
    assertMoney(interest, `interestOverrides[${month}]`);
  }
  let balance = 0;
  return months.map((m) => {
    assertMoney(m.transactionsTotal, 'transactionsTotal');
    assertMoney(m.paymentsTotal, 'paymentsTotal');
    if (m.paymentsTotal < 0) throw new Error('paymentsTotal must be ≥ 0');
    const hasPayment = m.paymentsTotal > 0;
    const startBalance = balance;
    const interest = hasPayment
      ? (params.interestOverrides?.[m.month] ?? interestAt(startBalance, scaledApr))
      : 0;
    const escrow = hasPayment ? params.escrow : 0;
    const endBalance = startBalance + m.transactionsTotal - interest - escrow;
    balance = endBalance;
    return {
      month: m.month,
      startBalance,
      transactionsTotal: m.transactionsTotal,
      interest,
      escrow,
      endBalance,
      principalPaid: hasPayment ? m.paymentsTotal - interest - escrow : 0,
    };
  });
}

export interface PayoffArgs {
  /** Current balance (debt is negative; the sign is ignored). */
  debt: Money;
  apr: string;
  payment: Money;
  escrow: Money;
  /** Month of the first projected payment. */
  fromMonth: Month;
}

/**
 * Month of the final payment when paying `payment` monthly from `fromMonth`. Returns `fromMonth` when nothing is
 * owed, and "never" if the payment can't outpace interest and escrow or the debt isn't paid off within 1200 months.
 */
export function projectPayoff(args: PayoffArgs): Month | 'never' {
  const count = paymentsToPayoff(args.debt, parseApr(args.apr), args.payment, args.escrow);
  if (count === null) return 'never';
  return addMonths(args.fromMonth, Math.max(0, count - 1));
}
