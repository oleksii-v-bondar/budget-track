import { and, eq, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  addMonths,
  type BudgetResult,
  convertToBase,
  dateInMonth,
  evaluateTarget,
  type IsoDate,
  type Money,
  type Month,
  monthOf,
  type TargetContext,
  type TargetDef,
} from '../../engine';
import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { TargetDto, TargetEvaluationDto } from '../../shared/api/targets';
import { monthStart } from '../budget/assignments';
import type { Executor } from '../db/client';
import { account, category, type target, transaction } from '../db/schema';
import type { FxQuote } from '../fx/fx-rates';
import { loanBalances, loanCharges } from '../loans/loan-balances';

export type TargetRow = typeof target.$inferSelect;
export type DebtContext = NonNullable<TargetContext['debt']>;

/** A target row in its API form, which is also the engine's `TargetDef` (spec §6): months become 'YYYY-MM'. */
export function toTargetDto(row: TargetRow): TargetDto & TargetDef {
  return {
    categoryId: row.categoryId,
    kind: row.kind,
    cadence: row.cadence,
    amount: row.amount,
    mode: row.mode,
    dueWeekday: row.dueWeekday,
    dueDayOfMonth: row.dueDayOfMonth,
    dueDate: row.dueDate,
    repeatUnit: row.repeatUnit,
    repeatEvery: row.repeatEvery,
    startMonth: monthOf(row.startMonth),
    debtMode: row.debtMode,
    snoozedMonth: row.snoozedMonth === null ? null : monthOf(row.snoozedMonth),
  };
}

/** The engine's target inputs for one category and month, read from the computed budget. */
export function targetContext(
  result: BudgetResult,
  month: Month,
  categoryId: string,
  debt?: DebtContext,
): TargetContext {
  const cell = result.byMonth[month]?.categories[categoryId];
  if (!cell) throw new Error(`Category ${categoryId} is not in the computed budget for ${month}`);
  return {
    month,
    carry: cell.carry,
    assigned: cell.assigned,
    available: cell.available,
    // Months outside the computed budget (before its start) hold no assignments.
    assignedIn: (m) => result.byMonth[m]?.categories[categoryId]?.assigned ?? 0,
    debt,
  };
}

/** The credit or loan account behind a credit card payment or paired loan category. */
export interface LinkedAccount {
  accountId: string;
  /** PLN balance at the end of the month, or today if that is earlier (negative while money is owed). */
  balanceAtMonthEnd: Money;
  /**
   * Debt target inputs (spec §6, §8) in PLN; a missing minimum payment or APR is 0 here. A foreign account's minimum
   * payment and escrow are converted at the latest NBP rate, or count as 0 without one.
   */
  debt: DebtContext;
  /** Account fields that are not set (PATCH /api/accounts/:id can clear them), and a foreign account's missing rate. */
  missing: { minPayment: boolean; interestRate: boolean; rate: boolean };
}

/** Currencies of the foreign accounts behind live credit card payment and paired loan categories. */
export async function linkedForeignCurrencies(db: Executor): Promise<string[]> {
  const rows = await db
    .selectDistinct({ currency: account.currency })
    .from(category)
    .innerJoin(account, eq(account.id, category.linkedAccountId))
    .where(and(isNull(category.deletedAt), ne(account.currency, BASE_CURRENCY)));
  return rows.map((row) => row.currency);
}

/**
 * The linked account of every live credit card payment and paired loan category, keyed by category id. Balances are
 * PLN base sums of the account's live transactions dated `today` or earlier (a split parent carries its lines' sum);
 * a loan's also include the interest and escrow charged in the months before (start) or through (end) `month`.
 * `rates` holds the latest NBP rate by currency (see `latestRates`), quoted before any transaction.
 */
export async function loadLinkedAccounts(
  db: Executor,
  month: Month,
  today: IsoDate,
  rates = new Map<string, FxQuote>(),
): Promise<Map<string, LinkedAccount>> {
  const monthEnd = dateInMonth(month, 31);
  const through = monthEnd < today ? monthEnd : today;
  const beforeMonth = sql`${transaction.date} < ${monthStart(month)}`;
  const rows = await db
    .select({
      categoryId: category.id,
      accountId: account.id,
      accountClass: account.accountClass,
      currency: account.currency,
      interestRate: account.interestRate,
      minPayment: account.minPayment,
      escrowAmount: account.escrowAmount,
      beforeMonth: sql<number>`coalesce(sum(${transaction.amountBase}) filter (where ${beforeMonth}), 0)::bigint`,
      throughMonth: sql<number>`coalesce(sum(${transaction.amountBase}), 0)::bigint`,
    })
    .from(category)
    .innerJoin(account, eq(account.id, category.linkedAccountId))
    .leftJoin(
      transaction,
      and(eq(transaction.accountId, account.id), isNull(transaction.deletedAt), lte(transaction.date, through)),
    )
    .where(isNull(category.deletedAt))
    .groupBy(category.id, account.id);
  const loans = await loanBalances(db, rows.map((row) => row.accountId));
  return new Map(
    rows.map((row) => {
      const foreign = row.currency !== BASE_CURRENCY;
      const rate = rates.get(row.currency)?.rate ?? null;
      // Spec §6 takes these as PLN; a foreign account's are in its own currency.
      const toPln = (amount: Money) =>
        !foreign ? amount : rate === null ? 0 : Math.min(convertToBase(amount, rate), Number.MAX_SAFE_INTEGER);
      const loan = loans.get(row.accountId);
      const linked: LinkedAccount = {
        accountId: row.accountId,
        balanceAtMonthEnd: row.throughMonth + loanCharges(loan, addMonths(month, 1)).amountBase,
        debt: {
          minPayment: toPln(row.minPayment ?? 0),
          apr: row.interestRate ?? '0',
          balanceAtMonthStart: row.beforeMonth + loanCharges(loan, month).amountBase,
          // Spec §6: escrow is added for loans only.
          escrow: row.accountClass === 'tracking' ? toPln(row.escrowAmount ?? 0) : 0,
        },
        missing: {
          minPayment: row.minPayment === null,
          interestRate: row.interestRate === null,
          rate: foreign && rate === null,
        },
      };
      return [row.categoryId, linked];
    }),
  );
}

/**
 * Evaluates a category's target for `month` (spec §6); null before the target's start month. A debt target whose
 * account lacks its minimum payment or APR, or a foreign account's latest NBP rate, is evaluated with 0 for it and
 * flagged `incomplete`.
 */
export function evaluateCategoryTarget(
  def: TargetDef,
  result: BudgetResult,
  month: Month,
  categoryId: string,
  linked?: LinkedAccount,
): TargetEvaluationDto | null {
  const evaluation = evaluateTarget(def, targetContext(result, month, categoryId, linked?.debt));
  if (!evaluation) return null;
  const incomplete =
    def.kind === 'debt' &&
    ((def.debtMode === 'min_payment' && linked?.missing.minPayment === true) ||
      (def.debtMode === 'payoff_by_date' && linked?.missing.interestRate === true) ||
      (def.debtMode !== 'fixed' && linked?.missing.rate === true));
  return { ...evaluation, incomplete };
}
