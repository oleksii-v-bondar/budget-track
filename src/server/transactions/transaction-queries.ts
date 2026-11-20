import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { BASE_CURRENCY } from '../../shared/api/accounts';
import type { RegisterQuery, RegisterResponse, SplitLineDto, TransactionDto } from '../../shared/api/transactions';
import { effectiveRate, type Money } from '../../engine';
import { getAccount } from '../accounts/account-queries';
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

const DEFAULT_PAGE_SIZE = 50;

/** A live split line of the row matching `condition` (written against aliases s, sp and sc). */
const lineWhere = (condition: SQL) => sql`exists (
  select 1 from ${subtransaction} s
  left join ${payee} sp on sp.id = s.payee_id
  left join ${category} sc on sc.id = s.category_id
  where s.txn_id = ${transaction.id} and s.deleted_at is null and ${condition})`;

/** ILIKE pattern for a literal substring: %, _ and \ in the text match only themselves. */
const containing = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function registerWhere(query: RegisterQuery): SQL | undefined {
  const pattern = query.q === undefined ? null : containing(query.q);
  return and(
    query.accountId ? eq(transaction.accountId, query.accountId) : undefined,
    pattern === null
      ? undefined
      : or(
          ilike(payee.name, pattern),
          ilike(transaction.memo, pattern),
          ilike(category.name, pattern),
          lineWhere(sql`(s.memo ilike ${pattern} or sp.name ilike ${pattern} or sc.name ilike ${pattern})`),
        ),
    query.from ? gte(transaction.date, query.from) : undefined,
    query.to ? lte(transaction.date, query.to) : undefined,
    query.minAmount === undefined ? undefined : gte(transaction.amount, query.minAmount),
    query.maxAmount === undefined ? undefined : lte(transaction.amount, query.maxAmount),
    query.categoryId
      ? or(eq(transaction.categoryId, query.categoryId), lineWhere(sql`s.category_id = ${query.categoryId}`))
      : undefined,
    query.payeeId
      ? or(eq(transaction.payeeId, query.payeeId), lineWhere(sql`s.payee_id = ${query.payeeId}`))
      : undefined,
    query.flag ? eq(transaction.flag, query.flag) : undefined,
    query.cleared ? eq(transaction.cleared, query.cleared) : undefined,
    query.unapproved ? eq(transaction.approved, false) : undefined,
    query.cursor
      ? sql`(${transaction.date}, ${transaction.id}) < (${query.cursor.date}::date, ${query.cursor.id}::uuid)`
      : undefined,
  );
}

/** Spec §10 "Search" and §11 Register: one page of matching transactions, plus the account's balances. */
export async function listRegister(db: Executor, query: RegisterQuery): Promise<RegisterResponse> {
  const balances = query.accountId ? await getAccount(db, query.accountId) : null;
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
  const rows = await loadTransactions(db, registerWhere(query), limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    transactions: page,
    nextCursor: rows.length > limit && last ? `${last.date}_${last.id}` : null,
    balances: balances && { balance: balances.balance, balanceBase: balances.balanceBase },
  };
}
