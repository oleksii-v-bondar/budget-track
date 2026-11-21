import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { isLoanType } from '../../shared/accounts';
import {
  computeLoanMonths,
  type IsoDate,
  type LoanMonth,
  type Money,
  type Month,
  monthOf,
  roundDiv,
} from '../../engine';
import type { Executor } from '../db/client';
import { account, loanInterestOverride, payee, transaction } from '../db/schema';

/** One month of a loan (spec §8): the engine's roll-forward, in the loan's currency, plus what the server knows. */
export interface LoanMonthRow extends LoanMonth {
  /** The day of the month's first payment, when interest and escrow are charged; null in a month without one. */
  chargedOn: IsoDate | null;
  /** The interest is a `loan_interest_override`, not APR / 12 of the start balance. */
  interestOverridden: boolean;
  /** PLN values at the rate the month's payments were booked at (the native amounts for PLN loans). */
  interestBase: Money;
  escrowBase: Money;
}

export interface LoanBalances {
  accountId: string;
  /** Months with transactions, in order; interest and escrow are charged only in months with a payment. */
  months: LoanMonthRow[];
  /** Months with an uncleared payment: their interest and escrow are uncleared too (see `loanBalances`). */
  unclearedMonths: Set<Month>;
}

/**
 * Spec §8: each loan account's months rolled forward by `computeLoanMonths` from its live transactions (per month:
 * Σ amounts and Σ payments), its APR (none = 0 %), escrow and interest overrides. This is the one place that turns
 * loans into synthetic interest and escrow: account balances, the register header, debt targets and the loan panel
 * all take them from here. Accounts that aren't loans are left out.
 *
 * A payment is an inflow whose payee isn't a system payee: the starting balance, a reconciliation adjustment and an
 * FX revaluation are the app's own bookings, so they count in the month's Σ amounts but never as payments. Otherwise
 * an adjustment inflow would charge the month's interest and escrow, and the cleared balance would miss the statement
 * it was just reconciled to.
 *
 * A month's interest and escrow are cleared iff every payment in that month is (cleared or reconciled); while any of
 * them is uncleared, they are uncleared too. So entering an uncleared payment never moves the cleared balance, and a
 * statement that doesn't show the payment yet still matches it in reconcile.
 *
 * A loan's first month has no interest, even with a payment in it: spec §8 rolls the balance forward from 0 at the
 * start of that month (its starting balance is one of the month's transactions). Users who were charged interest that
 * month can add an interest override for it.
 */
export async function loanBalances(db: Executor, accountIds: string[]): Promise<Map<string, LoanBalances>> {
  if (accountIds.length === 0) return new Map();
  const loans = (await db.select().from(account).where(inArray(account.id, accountIds))).filter((a) =>
    isLoanType(a.type),
  );
  if (loans.length === 0) return new Map();
  const ids = loans.map((loan) => loan.id);
  const month = sql<Month>`to_char(${transaction.date}, 'YYYY-MM')`;
  const payment = sql`${transaction.amount} > 0 and ${payee.systemKind} is null`;
  const uncleared = sql`${transaction.cleared} = 'uncleared'`;
  const rows = await db
    .select({
      accountId: transaction.accountId,
      month,
      total: sql<number>`sum(${transaction.amount})::bigint`,
      payments: sql<number>`coalesce(sum(${transaction.amount}) filter (where ${payment}), 0)::bigint`,
      paymentsBase: sql<number>`coalesce(sum(${transaction.amountBase}) filter (where ${payment}), 0)::bigint`,
      firstPayment: sql<IsoDate | null>`to_char(min(${transaction.date}) filter (where ${payment}), 'YYYY-MM-DD')`,
      unclearedPayment: sql<boolean>`coalesce(bool_or(${uncleared}) filter (where ${payment}), false)`,
    })
    .from(transaction)
    .leftJoin(payee, eq(payee.id, transaction.payeeId))
    .where(and(inArray(transaction.accountId, ids), isNull(transaction.deletedAt)))
    .groupBy(transaction.accountId, month)
    .orderBy(asc(month));
  const overrides = await db.select().from(loanInterestOverride).where(inArray(loanInterestOverride.accountId, ids));

  const result = new Map<string, LoanBalances>();
  for (const loan of loans) {
    const own = rows.filter((r) => r.accountId === loan.id);
    const interestOverrides = Object.fromEntries(
      overrides.filter((o) => o.accountId === loan.id).map((o) => [monthOf(o.month), o.amount]),
    );
    const months = computeLoanMonths(
      { apr: loan.interestRate ?? '0', escrow: loan.escrowAmount ?? 0, interestOverrides },
      own.map((r) => ({ month: r.month, transactionsTotal: r.total, paymentsTotal: r.payments })),
    );
    result.set(loan.id, {
      accountId: loan.id,
      unclearedMonths: new Set(own.filter((r) => r.unclearedPayment).map((r) => r.month)),
      months: months.map((m, i) => {
        const { payments, paymentsBase, firstPayment } = own[i]!;
        // Charged with the payments, so in PLN at their rate: paymentsBase / payments.
        const toBase = (native: Money) =>
          payments === 0 ? 0 : Number(roundDiv(BigInt(native) * BigInt(paymentsBase), BigInt(payments)));
        return {
          ...m,
          chargedOn: firstPayment,
          interestOverridden: m.month in interestOverrides,
          interestBase: toBase(m.interest),
          escrowBase: toBase(m.escrow),
        };
      }),
    });
  }
  return result;
}

export interface Charges {
  amount: Money;
  amountBase: Money;
}

/**
 * The interest and escrow a loan was charged in months before `before` (every month when omitted), as the negative
 * native and PLN amounts they add to its balance: in total, and split into the months whose payments are all cleared
 * and the others (see `loanBalances`). Zero for accounts that aren't loans.
 */
export function loanCharges(
  loan: LoanBalances | undefined,
  before?: Month,
): Charges & { cleared: Charges; uncleared: Charges } {
  const cleared = { amount: 0, amountBase: 0 };
  const uncleared = { amount: 0, amountBase: 0 };
  for (const m of loan?.months ?? []) {
    if (before !== undefined && m.month >= before) break;
    const part = loan?.unclearedMonths.has(m.month) ? uncleared : cleared;
    part.amount -= m.interest + m.escrow;
    part.amountBase -= m.interestBase + m.escrowBase;
  }
  return {
    amount: cleared.amount + uncleared.amount,
    amountBase: cleared.amountBase + uncleared.amountBase,
    cleared,
    uncleared,
  };
}
