import { and, asc, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { SplitLineDto, TransactionDto } from '../../shared/api/transactions';
import { effectiveRate, type Money } from '../../engine';
import type { Executor } from '../db/client';
import { account, category, payee, subtransaction, transaction } from '../db/schema';
import { AppError } from '../http/errors';

const transferAccount = alias(account, 'transfer_account');
const otherSide = alias(transaction, 'other_side');
const otherLine = alias(subtransaction, 'other_line');

const rateOf = (currency: string, amount: Money, amountBase: Money) =>
  currency === BASE_CURRENCY ? null : effectiveRate(amount, amountBase);

/** The live lines of the given split transactions, in order. */
async function linesOf(db: Executor, txnIds: string[]): Promise<Map<string, SplitLineDto[]>> {
  const byTxn = new Map<string, SplitLineDto[]>();
  if (txnIds.length === 0) return byTxn;
  const rows = await db
    .select({
      line: subtransaction,
      payeeName: payee.name,
      categoryName: category.name,
      accountName: transferAccount.name,
    })
    .from(subtransaction)
    .leftJoin(payee, eq(payee.id, subtransaction.payeeId))
    .leftJoin(category, eq(category.id, subtransaction.categoryId))
    .leftJoin(transferAccount, eq(transferAccount.id, subtransaction.transferAccountId))
    .where(and(inArray(subtransaction.txnId, txnIds), isNull(subtransaction.deletedAt)))
    .orderBy(asc(subtransaction.sortOrder), asc(subtransaction.id));
  for (const { line, payeeName, categoryName, accountName } of rows) {
    const list = byTxn.get(line.txnId) ?? [];
    list.push({
      id: line.id,
      amount: line.amount,
      amountBase: line.amountBase,
      payeeId: line.payeeId,
      payeeName,
      categoryId: line.categoryId,
      categoryName,
      memo: line.memo,
      transfer:
        line.transferAccountId && line.transferTxnId && accountName !== null
          ? { accountId: line.transferAccountId, accountName, transactionId: line.transferTxnId }
          : null,
    });
    byTxn.set(line.txnId, list);
  }
  return byTxn;
}

/** Live transactions matching `where`, newest first (date desc, id desc), as DTOs. */
export async function loadTransactions(db: Executor, where?: SQL, limit?: number): Promise<TransactionDto[]> {
  const query = db
    .select({
      txn: transaction,
      accountName: account.name,
      currency: account.currency,
      payeeName: payee.name,
      categoryName: category.name,
      transferAccount: { name: transferAccount.name, currency: transferAccount.currency },
      other: { amount: otherSide.amount, amountBase: otherSide.amountBase },
      line: { amount: otherLine.amount, amountBase: otherLine.amountBase },
    })
    .from(transaction)
    .innerJoin(account, eq(account.id, transaction.accountId))
    .leftJoin(payee, eq(payee.id, transaction.payeeId))
    .leftJoin(category, eq(category.id, transaction.categoryId))
    .leftJoin(transferAccount, eq(transferAccount.id, transaction.transferAccountId))
    .leftJoin(otherSide, eq(otherSide.id, transaction.transferTxnId))
    .leftJoin(otherLine, eq(otherLine.id, transaction.transferSubtxnId))
    .where(and(isNull(transaction.deletedAt), where))
    .orderBy(desc(transaction.date), desc(transaction.id));
  const rows = await (limit === undefined ? query : query.limit(limit));
  const lines = await linesOf(db, rows.filter((r) => r.txn.isSplit).map((r) => r.txn.id));
  return rows.map(({ txn, accountName, currency, payeeName, categoryName, transferAccount: to, ...sides }) => {
    // The counterpart of a split line faces that line, not the whole split.
    const other = sides.line ?? sides.other;
    return {
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
      effectiveRate: rateOf(currency, txn.amount, txn.amountBase),
      cleared: txn.cleared,
      approved: txn.approved,
      flag: txn.flag,
      isStartingBalance: txn.isStartingBalance,
      isSplit: txn.isSplit,
      transfer:
        txn.transferAccountId && txn.transferTxnId && to && other
          ? {
              accountId: txn.transferAccountId,
              accountName: to.name,
              transactionId: txn.transferTxnId,
              splitLineId: txn.transferSubtxnId,
              amount: other.amount,
              currency: to.currency,
              effectiveRate: rateOf(to.currency, other.amount, other.amountBase),
            }
          : null,
      lines: lines.get(txn.id) ?? [],
    };
  });
}

export async function getTransaction(db: Executor, id: string): Promise<TransactionDto> {
  const [found] = await loadTransactions(db, eq(transaction.id, id));
  if (!found) throw new AppError(404, 'not_found', 'Transaction not found.');
  return found;
}
