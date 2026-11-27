import { and, eq, inArray, isNotNull, isNull, lt, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { diffDays, type IsoDate } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import { payee, transaction } from '../db/schema';

/**
 * Revolut rounds each card purchase up to a multiple of 5 PLN (500 grosze) and moves the difference to a vault, as a
 * separate transaction: a purchase and its round-up add up to a multiple of this.
 */
export const ROUNDUP_UNIT = 500;
/** The bank text of a round-up, the move to a vault: "To PLN MB:be9ad…". */
const ROUNDUP_TEXT = /^To [A-Z]{3} MB:/i;
/** A round-up is dated at most this many days from its purchase. */
const ROUNDUP_DAYS = 1;

/** A live, plain (no transfer or split), unlinked row that may be a round-up or a purchase. */
export interface RoundUpCandidate {
  id: string;
  accountId: string;
  date: IsoDate;
  amount: number;
  createdAt: Date;
  /** The bank's text (`imported_payee`), else the payee's name. */
  text: string | null;
}

const vaultText = (row: RoundUpCandidate) => row.text !== null && ROUNDUP_TEXT.test(row.text);

/**
 * Pairs round-ups with their purchases; returns round-up id → purchase id. A round-up has the vault's text and is an
 * outflow of at most `ROUNDUP_UNIT`. Its purchase is an outflow in the same account (not a move to a vault), dated
 * within a day, that adds up with it to a multiple of `ROUNDUP_UNIT`: the same date first, then the closest
 * `created_at`. A round-up whose best two purchases tie stays alone; a purchase takes one round-up.
 */
export function matchRoundUps(rows: RoundUpCandidate[]): Map<string, string> {
  const roundUps = rows
    .filter((r) => vaultText(r) && r.amount < 0 && -r.amount <= ROUNDUP_UNIT)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const purchases = rows.filter((x) => x.amount < 0 && !vaultText(x));
  const links = new Map<string, string>();
  const taken = new Set<string>();
  for (const r of roundUps) {
    const ranked = purchases
      .filter(
        (x) =>
          !taken.has(x.id) &&
          x.accountId === r.accountId &&
          Math.abs(diffDays(x.date, r.date)) <= ROUNDUP_DAYS &&
          (x.amount + r.amount) % ROUNDUP_UNIT === 0,
      )
      .map((x) => ({ x, day: x.date === r.date ? 0 : 1, apart: Math.abs(x.createdAt.getTime() - r.createdAt.getTime()) }))
      .sort((a, b) => a.day - b.day || a.apart - b.apart);
    const [best, next] = ranked;
    if (!best || (next && next.day === best.day && next.apart === best.apart)) continue;
    taken.add(best.x.id);
    links.set(r.id, best.x.id);
  }
  return links;
}

/**
 * The bank sync's last step: links each new Revolut round-up of the accounts (all without `accountIds`) to its
 * purchase (`matchRoundUps`); the round-up takes the purchase's category and approval. First, a round-up whose
 * purchase the sync deleted or paired into a transfer is unlinked, to show on its own.
 */
export async function linkRoundUps(rec: ChangeRecorder, accountIds?: string[]): Promise<void> {
  if (accountIds?.length === 0) return;
  const inAccounts = accountIds ? inArray(transaction.accountId, accountIds) : undefined;
  const purchase = alias(transaction, 'purchase');
  // The purchase keeps its round-up while it is live, plain and in the round-up's account.
  const kept = rec.tx
    .select({ id: purchase.id })
    .from(purchase)
    .where(
      and(
        eq(purchase.id, transaction.roundupOf),
        eq(purchase.accountId, transaction.accountId),
        isNull(purchase.deletedAt),
        isNull(purchase.transferTxnId),
        eq(purchase.isSplit, false),
      ),
    );
  await rec.update(
    transaction,
    and(inAccounts, isNotNull(transaction.roundupOf), isNull(transaction.deletedAt), notExists(kept)),
    { roundupOf: null },
  );
  const linked = alias(transaction, 'linked');
  const rows = await rec.tx
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      date: transaction.date,
      amount: transaction.amount,
      createdAt: transaction.createdAt,
      text: sql<string | null>`coalesce(${transaction.importedPayee}, ${payee.name})`,
      categoryId: transaction.categoryId,
      approved: transaction.approved,
    })
    .from(transaction)
    .leftJoin(payee, eq(payee.id, transaction.payeeId))
    .where(
      and(
        inAccounts,
        isNull(transaction.deletedAt),
        lt(transaction.amount, 0),
        isNull(transaction.transferTxnId),
        eq(transaction.isSplit, false),
        eq(transaction.isStartingBalance, false),
        isNull(transaction.roundupOf),
        notExists(
          rec.tx
            .select({ id: linked.id })
            .from(linked)
            .where(and(eq(linked.roundupOf, transaction.id), isNull(linked.deletedAt))),
        ),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const [roundUpId, purchaseId] of matchRoundUps(rows)) {
    const { categoryId, approved } = byId.get(purchaseId)!;
    await rec.update(transaction, eq(transaction.id, roundUpId), { roundupOf: purchaseId, categoryId, approved });
  }
}

/**
 * Keeps a purchase's round-up in step after an edit: it takes the purchase's category, and its approval once the
 * purchase is approved. A purchase that became a transfer or a split, or moved to another account, lets it go.
 */
export async function followPurchase(rec: ChangeRecorder, id: string): Promise<void> {
  const [x] = await rec.tx.select().from(transaction).where(eq(transaction.id, id));
  const own = and(eq(transaction.roundupOf, id), isNull(transaction.deletedAt));
  const plain = x && !x.deletedAt && !x.transferTxnId && !x.isSplit;
  await rec.update(transaction, plain ? and(own, ne(transaction.accountId, x.accountId)) : own, { roundupOf: null });
  if (plain) await rec.update(transaction, own, { categoryId: x.categoryId, approved: x.approved || undefined });
}
