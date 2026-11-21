import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type AccountDto, BASE_CURRENCY } from '../../shared/api/accounts';
import type { LoanPanelDto } from '../../shared/api/budget';
import type { TargetDto } from '../../shared/api/targets';
import { addMonths, type IsoDate, type Money, monthOf, parseDecimal, projectPayoff, roundDiv } from '../../engine';
import { listAccounts } from '../accounts/account-queries';
import type { Executor } from '../db/client';
import { account, transaction } from '../db/schema';
import type { FxQuote } from '../fx/fx-rates';
import { loanBalances } from './loan-balances';

/** What the loan panel needs beyond the month's target. */
export interface LoanInfo {
  account: AccountDto;
  /**
   * This month has a payment (an inflow without a system payee, as `loanBalances` counts it), so its interest and
   * escrow are in the balance: the projection starts next month.
   */
  paidThisMonth: boolean;
  /** Spec §8 "Record payment": the cash account of the latest payment, else the first open cash account. */
  paymentAccountId: string | null;
}

const paymentAccount = alias(account, 'payment_account');

/** Loads the panel data of the given loan accounts (spec §8), keyed by account id. */
export async function loadLoanInfo(db: Executor, accountIds: string[], today: IsoDate): Promise<Map<string, LoanInfo>> {
  if (accountIds.length === 0) return new Map();
  const accounts = await listAccounts(db, inArray(account.id, accountIds));
  const openCash = and(eq(paymentAccount.accountClass, 'cash'), eq(paymentAccount.closed, false));
  const [firstCash] = await db
    .select({ id: paymentAccount.id })
    .from(paymentAccount)
    .where(openCash)
    .orderBy(asc(paymentAccount.sortOrder), asc(paymentAccount.createdAt), asc(paymentAccount.id))
    .limit(1);
  // The open cash account of each loan's latest transfer in, in one query.
  const latest = await db
    .selectDistinctOn([transaction.accountId], { loanId: transaction.accountId, id: paymentAccount.id })
    .from(transaction)
    .innerJoin(paymentAccount, eq(paymentAccount.id, transaction.transferAccountId))
    .where(
      and(
        inArray(transaction.accountId, accountIds),
        isNull(transaction.deletedAt),
        gt(transaction.amount, 0),
        openCash,
      ),
    )
    .orderBy(transaction.accountId, desc(transaction.date), desc(transaction.id));
  const latestByLoan = new Map(latest.map((row) => [row.loanId, row.id]));
  const balances = await loanBalances(db, accountIds);
  const result = new Map<string, LoanInfo>();
  for (const loan of accounts) {
    const thisMonth = balances.get(loan.id)?.months.find((m) => m.month === monthOf(today));
    result.set(loan.id, {
      account: loan,
      paidThisMonth: Boolean(thisMonth?.chargedOn),
      paymentAccountId: latestByLoan.get(loan.id) ?? firstCash?.id ?? null,
    });
  }
  return result;
}

/** PLN → the loan's currency at `rate` (the inverse of convertToBase), rounded half away from zero. */
const fromBase = (amountBase: Money, rate: string): Money =>
  Number(roundDiv(BigInt(amountBase) * 1_000_000n, parseDecimal(rate, 6)));

/**
 * The monthly payment the payoff projection assumes, in the loan's currency (spec §8): a fixed or pay-off-by-date debt
 * target's need, else the minimum payment. A foreign loan converts the need back at the latest NBP rate.
 */
function projectedPayment(info: LoanInfo, target: TargetDto | null, need: Money | null, rate?: FxQuote): Money {
  const { currency, minPayment } = info.account;
  const byTarget = target?.kind === 'debt' && target.debtMode !== 'min_payment' && need !== null;
  if (!byTarget) return minPayment ?? 0;
  if (currency === BASE_CURRENCY) return need;
  return rate ? fromBase(need, rate.rate) : (minPayment ?? 0);
}

/** The loan panel of a paired category for the month whose target `need` is given (null without one). */
export function loanPanel(
  info: LoanInfo,
  categoryId: string,
  target: TargetDto | null,
  need: Money | null,
  today: IsoDate,
  rate?: FxQuote,
): LoanPanelDto {
  const loan = info.account;
  const currentMonth = monthOf(today);
  const payoff = projectPayoff({
    debt: Math.min(0, loan.balance.working),
    apr: loan.interestRate ?? '0',
    payment: projectedPayment(info, target, need, rate),
    escrow: loan.escrowAmount ?? 0,
    fromMonth: info.paidThisMonth ? addMonths(currentMonth, 1) : currentMonth,
  });
  return {
    accountId: loan.id,
    accountName: loan.name,
    currency: loan.currency,
    balance: loan.balance.working,
    balanceBase: loan.balanceBase.working,
    interestRate: loan.interestRate,
    minPayment: loan.minPayment,
    escrowAmount: loan.escrowAmount,
    projectedPayoff: payoff,
    recordPayment: {
      accountId: info.paymentAccountId,
      payeeId: loan.transferPayeeId,
      categoryId,
      amount: need ? -need : 0,
    },
  };
}
