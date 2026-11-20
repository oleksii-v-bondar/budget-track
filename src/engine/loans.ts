import { addMonths } from './dates';
import { ceilDiv, parseDecimal, roundDiv } from './money';
import type { Money, Month } from './types';

const APR_SCALE = 4;
const MAX_PAYOFF_MONTHS = 1200;

/** Interest for one month: |balance| × APR / 12, rounded half away from zero. `apr` is a percentage, e.g. "6.5". */
export function monthlyInterest(balance: Money, apr: string): Money {
  const scaledApr = parseDecimal(apr, APR_SCALE);
  return Number(roundDiv(BigInt(Math.abs(balance)) * scaledApr, 12n * 100n * 10n ** BigInt(APR_SCALE)));
}

/** Level monthly payment repaying `principal` (≥ 0) over `months` (≥ 1) payments at `apr`, rounded up. */
export function amortizedPayment(principal: Money, apr: string, months: number): Money {
  if (months < 1) throw new Error(`amortizedPayment: months must be ≥ 1, got ${months}`);
  if (principal <= 0) return 0;
  const rate = Number(apr) / 100 / 12;
  if (rate === 0) return ceilDiv(principal, months);
  return Math.ceil((rate * principal) / (1 - (1 + rate) ** -months));
}

export interface LoanParams {
  apr: string;
  escrow: Money;
  interestOverrides?: Record<Month, Money>;
}

export interface LoanMonthInput {
  month: Month;
  /** Σ native amounts of the loan account's transactions in the month (debt is negative). */
  transactionsTotal: Money;
  /** True when the month contains at least one inflow (a payment). */
  hasPayment: boolean;
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
 * Interest and escrow are charged only in months with a payment.
 */
export function computeLoanMonths(params: LoanParams, months: LoanMonthInput[]): LoanMonth[] {
  let balance = 0;
  return months.map((m) => {
    const startBalance = balance;
    const interest = m.hasPayment
      ? (params.interestOverrides?.[m.month] ?? monthlyInterest(startBalance, params.apr))
      : 0;
    const escrow = m.hasPayment ? params.escrow : 0;
    const endBalance = startBalance + m.transactionsTotal - interest - escrow;
    balance = endBalance;
    return {
      month: m.month,
      startBalance,
      transactionsTotal: m.transactionsTotal,
      interest,
      escrow,
      endBalance,
      principalPaid: m.hasPayment ? m.transactionsTotal - interest - escrow : 0,
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

/** Month of the final payment when paying `payment` monthly, or "never" if the payment can't outpace interest. */
export function projectPayoff(args: PayoffArgs): Month | 'never' {
  let remaining = Math.abs(args.debt);
  if (remaining === 0) return args.fromMonth;
  for (let i = 0; i < MAX_PAYOFF_MONTHS; i++) {
    const principal = args.payment - args.escrow - monthlyInterest(remaining, args.apr);
    if (principal <= 0) return 'never';
    remaining -= principal;
    if (remaining <= 0) return addMonths(args.fromMonth, i);
  }
  return 'never';
}
