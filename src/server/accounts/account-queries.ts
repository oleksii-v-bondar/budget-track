import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { AccountBalances, AccountDto } from '../../shared/api/accounts';
import type { Executor } from '../db/client';
import { account, category, payee, transaction } from '../db/schema';
import { AppError } from '../http/errors';

interface Sums {
  cleared: number;
  uncleared: number;
  clearedBase: number;
  unclearedBase: number;
}

const ZERO: Sums = { cleared: 0, uncleared: 0, clearedBase: 0, unclearedBase: 0 };

const balances = (cleared: number, uncleared: number): AccountBalances => ({
  cleared,
  uncleared,
  working: cleared + uncleared,
});

/** Native and PLN sums of the live transactions per account (split parents carry their lines' total). */
async function sumsByAccount(db: Executor, accountIds: string[]): Promise<Map<string, Sums>> {
  if (accountIds.length === 0) return new Map();
  const isCleared = sql`${transaction.cleared} <> 'uncleared'`;
  const rows = await db
    .select({
      accountId: transaction.accountId,
      // sum() of bigint is numeric (a string in JS); the ::bigint cast brings it back as an exact number.
      cleared: sql<number>`coalesce(sum(${transaction.amount}) filter (where ${isCleared}), 0)::bigint`,
      uncleared: sql<number>`coalesce(sum(${transaction.amount}) filter (where not ${isCleared}), 0)::bigint`,
      clearedBase: sql<number>`coalesce(sum(${transaction.amountBase}) filter (where ${isCleared}), 0)::bigint`,
      unclearedBase: sql<number>`coalesce(sum(${transaction.amountBase}) filter (where not ${isCleared}), 0)::bigint`,
    })
    .from(transaction)
    .where(and(inArray(transaction.accountId, accountIds), isNull(transaction.deletedAt)))
    .groupBy(transaction.accountId);
  return new Map(rows.map(({ accountId, ...sums }) => [accountId, sums]));
}

/** Accounts in display order (spec §11 Accounts), with their balances. */
export async function listAccounts(db: Executor, where?: SQL): Promise<AccountDto[]> {
  const rows = await db
    .select({ account, transferPayeeId: payee.id, linkedCategoryId: category.id })
    .from(account)
    .innerJoin(payee, eq(payee.transferAccountId, account.id))
    .leftJoin(category, and(eq(category.linkedAccountId, account.id), isNull(category.deletedAt)))
    .where(where)
    .orderBy(asc(account.sortOrder), asc(account.createdAt), asc(account.id));
  const sums = await sumsByAccount(db, rows.map((r) => r.account.id));
  return rows.map(({ account: a, transferPayeeId, linkedCategoryId }) => {
    const s = sums.get(a.id) ?? ZERO;
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      accountClass: a.accountClass,
      currency: a.currency,
      closed: a.closed,
      sortOrder: a.sortOrder,
      note: a.note,
      interestRate: a.interestRate,
      minPayment: a.minPayment,
      escrowAmount: a.escrowAmount,
      lastReconciledAt: a.lastReconciledAt?.toISOString() ?? null,
      lastReconciledBalance: a.lastReconciledBalance,
      transferPayeeId,
      paymentCategoryId: a.accountClass === 'credit' ? linkedCategoryId : null,
      pairedCategoryId: a.pairedCategoryId,
      balance: balances(s.cleared, s.uncleared),
      balanceBase: balances(s.clearedBase, s.unclearedBase),
    };
  });
}

export async function getAccount(db: Executor, id: string): Promise<AccountDto> {
  const [found] = await listAccounts(db, eq(account.id, id));
  if (!found) throw new AppError(404, 'not_found', 'Account not found.');
  return found;
}
