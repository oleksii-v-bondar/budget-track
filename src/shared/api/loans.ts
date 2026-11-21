import { z } from 'zod';
import { boundedMoneySchema, idSchema, monthSchema } from './common';

export const loanMonthParamSchema = z.object({ id: idSchema, month: monthSchema });

/**
 * PUT /api/accounts/:id/interest-overrides/:month: the month's interest, in the loan's currency (spec §8), 0 …
 * MAX_AMOUNT like every amount that ends up in a balance. Only months with a payment take one (422 `no_loan_payment`),
 * and its PLN value at the rate of the month's payments stays within MAX_BASE_AMOUNT (422 `amount_too_large`).
 */
export const interestOverrideRequestSchema = z.object({
  amount: boundedMoneySchema.min(0, 'Enter 0 or more.'),
});

/**
 * One month of a loan (spec §8), in the loan's currency; the `…Base` amounts are PLN, at the rate the month's
 * payments were booked at. Interest and escrow are charged only in months with a payment.
 */
export interface LoanMonthDto {
  /** 'YYYY-MM' */
  month: string;
  startBalance: number;
  /** Σ of the month's transactions (payments are positive). */
  transactionsTotal: number;
  /** The "Interest charge" row; editing it sets an interest override. */
  interest: number;
  interestBase: number;
  /** The interest is an override rather than APR / 12 of the start balance; false in a month without a payment. */
  interestOverridden: boolean;
  /** The "Escrow" row. */
  escrow: number;
  escrowBase: number;
  endBalance: number;
  /** Payments − interest − escrow. */
  principalPaid: number;
  /**
   * The day of the month's first payment, null without one. The register shows the month's read-only "Interest
   * charge" and "Escrow" rows on this date, next to the transactions of that day.
   */
  chargedOn: string | null;
  /**
   * The "Interest charge" and "Escrow" rows are cleared: a payment of the month is cleared or reconciled. While all
   * of them are uncleared, so are the charges (they count in the uncleared balance). True in a month without a
   * payment, which has no charges.
   */
  chargesCleared: boolean;
}

/**
 * GET /api/accounts/:id/loan: a loan's schedule from its first transaction to today. The register interleaves the
 * synthetic rows by `chargedOn`; its cursor paging over transactions is unchanged.
 */
export interface LoanDto {
  accountId: string;
  currency: string;
  /** APR in percent, e.g. "6.0000". */
  interestRate: string | null;
  minPayment: number | null;
  escrowAmount: number | null;
  /** Months with transactions, oldest first. */
  months: LoanMonthDto[];
}
