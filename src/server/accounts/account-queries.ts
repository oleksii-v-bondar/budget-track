import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { type AccountBalances, type AccountDto, BASE_CURRENCY } from '../../shared/api/accounts';
import { convertToBase, type IsoDate } from '../../engine';
import type { Db, Executor } from '../db/client';
import { account, category, payee, transaction } from '../db/schema';
import { type FxQuote, type FxRates, latestRates } from '../fx/fx-rates';
import { AppError } from '../http/errors';
import { loanBalances, loanCharges } from '../loans/loan-balances';

interface Sums {
  cleared: number;
  uncleared: number;
  clearedBase: number;
  unclearedBase: number;
  unapproved: number;
}

const ZERO: Sums = { cleared: 0, uncleared: 0, clearedBase: 0, unclearedBase: 0, unapproved: 0 };

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
      // A round-up is approved with its purchase.
      unapproved: sql<number>`(count(*) filter (where not ${transaction.approved} and ${transaction.roundupOf} is null))::int`,
    })
    .from(transaction)
    .where(and(inArray(transaction.accountId, accountIds), isNull(transaction.deletedAt)))
    .groupBy(transaction.accountId);
  return new Map(rows.map(({ accountId, ...sums }) => [accountId, sums]));
}

/** The working balance in PLN at the latest rate ("≈ X zł"); null when it can't be computed or stored exactly. */
function atRate(working: number, quote: FxQuote | null): number | null {
  if (!quote || !Number.isSafeInteger(working)) return null;
  const base = convertToBase(working, quote.rate);
  return Number.isSafeInteger(base) ? base : null;
}

/**
 * Accounts in display order (spec §11 Accounts), with their balances; a loan's include the interest and escrow it was
 * charged (spec §8), cleared with that month's first cleared payment (see `loanBalances`). `rates` holds the latest
 * NBP rate by currency for "≈ X zł" (see `readAccounts`); without one, a foreign account's `latestRate` is null.
 */
export async function listAccounts(
  db: Executor,
  where?: SQL,
  rates = new Map<string, FxQuote>(),
): Promise<AccountDto[]> {
  const rows = await db
    .select({ account, transferPayeeId: payee.id, linkedCategoryId: category.id })
    .from(account)
    .innerJoin(payee, eq(payee.transferAccountId, account.id))
    .leftJoin(category, and(eq(category.linkedAccountId, account.id), isNull(category.deletedAt)))
    .where(where)
    .orderBy(asc(account.sortOrder), asc(account.createdAt), asc(account.id));
  const ids = rows.map((r) => r.account.id);
  const sums = await sumsByAccount(db, ids);
  const loans = await loanBalances(db, ids);
  return rows.map(({ account: a, transferPayeeId, linkedCategoryId }) => {
    const booked = sums.get(a.id) ?? ZERO;
    const { cleared, uncleared } = loanCharges(loans.get(a.id));
    const s = {
      cleared: booked.cleared + cleared.amount,
      uncleared: booked.uncleared + uncleared.amount,
      clearedBase: booked.clearedBase + cleared.amountBase,
      unclearedBase: booked.unclearedBase + uncleared.amountBase,
    };
    const latestRate = a.currency === BASE_CURRENCY ? null : (rates.get(a.currency) ?? null);
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
      latestRate,
      balanceAtLatestRate: atRate(s.cleared + s.uncleared, latestRate),
      unapprovedCount: booked.unapproved,
    };
  });
}

export async function getAccount(db: Executor, id: string): Promise<AccountDto> {
  const [found] = await listAccounts(db, eq(account.id, id));
  if (!found) throw new AppError(404, 'not_found', 'Account not found.');
  return found;
}

/**
 * Accounts for API responses, with "≈ X zł": the latest NBP rate of each foreign currency is quoted first, once per
 * currency, outside any transaction (cache first; each quote is bounded by NBP's 5 s timeout). `quoted` holds today's
 * rates the request already has, so they aren't quoted again.
 */
export async function readAccounts(
  deps: { db: Db; fx: FxRates },
  today: IsoDate,
  where?: SQL,
  quoted = new Map<string, FxQuote>(),
): Promise<AccountDto[]> {
  const currencies = await deps.db.selectDistinct({ currency: account.currency }).from(account).where(where);
  const missing = currencies.map((row) => row.currency).filter((currency) => !quoted.has(currency));
  const rates = await latestRates(deps.fx, missing, today);
  return listAccounts(deps.db, where, new Map([...quoted, ...rates]));
}

export async function readAccount(
  deps: { db: Db; fx: FxRates },
  today: IsoDate,
  id: string,
  quoted?: Map<string, FxQuote>,
): Promise<AccountDto> {
  const [found] = await readAccounts(deps, today, eq(account.id, id), quoted);
  if (!found) throw new AppError(404, 'not_found', 'Account not found.');
  return found;
}
