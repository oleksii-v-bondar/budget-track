import { and, eq, isNull, sql } from 'drizzle-orm';
import { isLoanType } from '../../shared/accounts';
import type { LoanDto } from '../../shared/api/loans';
import { type IsoDate, type Money, type Month, monthOf } from '../../engine';
import { monthStart } from '../budget/assignments';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { account, loanInterestOverride, transaction } from '../db/schema';
import { AppError, DomainError } from '../http/errors';
import { assertBaseAmount } from '../transactions/rules';
import { loanBalances } from './loan-balances';

type AccountRow = typeof account.$inferSelect;

/** 404 for an unknown account, 422 `not_a_loan` unless it has a loan type (spec §3). */
async function loanAccount(db: Executor, id: string): Promise<AccountRow> {
  const [row] = await db.select().from(account).where(eq(account.id, id));
  if (!row) throw new AppError(404, 'not_found', 'Account not found.');
  if (!isLoanType(row.type)) throw new DomainError('not_a_loan', 'Only loans have interest and escrow.');
  return row;
}

/**
 * GET /api/accounts/:id/loan (spec §8). Each month's synthetic rows are cleared exactly when `loanCharges` counts
 * them in the cleared balance.
 */
export async function getLoan(db: Executor, id: string): Promise<LoanDto> {
  const loan = await loanAccount(db, id);
  const balances = (await loanBalances(db, [id])).get(id);
  const unclearedMonths = balances?.unclearedMonths ?? new Set();
  return {
    accountId: id,
    currency: loan.currency,
    interestRate: loan.interestRate,
    minPayment: loan.minPayment,
    escrowAmount: loan.escrowAmount,
    months: (balances?.months ?? []).map((m) => ({ ...m, chargesCleared: !unclearedMonths.has(m.month) })),
  };
}

/** A loan's months run from its first live transaction to the current month. */
async function assertLoanMonth(db: Executor, id: string, month: Month, today: IsoDate): Promise<void> {
  const [first] = await db
    .select({ date: sql<IsoDate | null>`to_char(min(${transaction.date}), 'YYYY-MM-DD')` })
    .from(transaction)
    .where(and(eq(transaction.accountId, id), isNull(transaction.deletedAt)));
  const from = first?.date ? monthOf(first.date) : null;
  const to = monthOf(today);
  if (from === null || month < from || month > to) {
    throw new DomainError(
      'month_out_of_range',
      from === null || from > to ? 'This loan has no transactions yet.' : `Pick a month from ${from} to ${to}.`,
      'month',
    );
  }
}

const overrideWhere = (id: string, month: Month) =>
  and(eq(loanInterestOverride.accountId, id), eq(loanInterestOverride.month, monthStart(month)));

/**
 * Spec §8: editing a month's "Interest charge" row replaces the computed interest with `amount` (in the loan's
 * currency). Only months with a payment have that row (422 `no_loan_payment` otherwise), and later months' interest
 * follows the new balance. Every month's interest stays within ±MAX_BASE_AMOUNT in PLN at the rate of its payments
 * (spec §4.4; `amount_too_large` on `amount`).
 */
export async function setInterestOverride(
  rec: ChangeRecorder,
  id: string,
  month: Month,
  amount: Money,
  today: IsoDate,
): Promise<{ name: string }> {
  const loan = await loanAccount(rec.tx, id);
  await assertLoanMonth(rec.tx, id, month, today);
  const months = async () => (await loanBalances(rec.tx, [id])).get(id)?.months ?? [];
  if (!(await months()).find((m) => m.month === month)?.chargedOn) {
    throw new DomainError(
      'no_loan_payment',
      'Interest is charged only in months with a payment. Enter the payment first.',
      'month',
    );
  }
  const [existing] = await rec.tx.select().from(loanInterestOverride).where(overrideWhere(id, month));
  if (existing) await rec.update(loanInterestOverride, overrideWhere(id, month), { amount });
  else await rec.insert(loanInterestOverride, { accountId: id, month: monthStart(month), amount });
  for (const m of await months()) assertBaseAmount(m.interestBase, 'amount');
  return { name: loan.name };
}

/** Goes back to the computed interest for the month. */
export async function deleteInterestOverride(rec: ChangeRecorder, id: string, month: Month): Promise<{ name: string }> {
  const loan = await loanAccount(rec.tx, id);
  if ((await rec.delete(loanInterestOverride, overrideWhere(id, month))).length === 0) {
    throw new AppError(404, 'not_found', 'This month has no interest override.');
  }
  return { name: loan.name };
}
