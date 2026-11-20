import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { TransactionDto } from '../../shared/api/transactions';
import { effectiveRate } from '../../engine';
import type { Executor } from '../db/client';
import { account, category, payee, transaction } from '../db/schema';
import { AppError } from '../http/errors';

/** Live transactions matching `where`, newest first (date desc, id desc), as DTOs. */
export async function loadTransactions(db: Executor, where?: SQL, limit?: number): Promise<TransactionDto[]> {
  const query = db
    .select({
      txn: transaction,
      accountName: account.name,
      currency: account.currency,
      payeeName: payee.name,
      categoryName: category.name,
    })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .leftJoin(payee, eq(payee.id, transaction.payeeId))
    .leftJoin(category, eq(category.id, transaction.categoryId))
    .where(and(isNull(transaction.deletedAt), where))
    .orderBy(desc(transaction.date), desc(transaction.id));
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.map(({ txn, accountName, currency, payeeName, categoryName }) => ({
    id: txn.id,
    accountId: txn.accountId,
    accountName,
    currency,
    date: txn.date,
    payeeId: txn.payeeId,
    payeeName,
    categoryId: txn.categoryId,
    categoryName,
    memo: txn.memo,
    amount: txn.amount,
    amountBase: txn.amountBase,
    fxRate: txn.fxRate,
    effectiveRate: currency === BASE_CURRENCY ? null : effectiveRate(txn.amount, txn.amountBase),
    cleared: txn.cleared,
    approved: txn.approved,
    flag: txn.flag,
    isStartingBalance: txn.isStartingBalance,
    isSplit: txn.isSplit,
    transfer: null,
    lines: [],
  }));
}

export async function getTransaction(db: Executor, id: string): Promise<TransactionDto> {
  const [found] = await loadTransactions(db, eq(transaction.id, id));
  if (!found) throw new AppError(404, 'not_found', 'Transaction not found.');
  return found;
}
