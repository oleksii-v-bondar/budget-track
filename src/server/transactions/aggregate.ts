import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { account, subtransaction, transaction } from '../db/schema';
import { AppError } from '../http/errors';
import type { Draft } from './plan';
import type { Rate } from './rules';

type TxnRow = typeof transaction.$inferSelect;
type LineRow = typeof subtransaction.$inferSelect;

/** A saved transaction with every row that belongs to it. */
export interface Aggregate {
  main: TxnRow;
  /** A plain transfer's other side. */
  counterpart: TxnRow | null;
  /** A split's live lines in order, each with the counterpart of a transfer line. */
  lines: { line: LineRow; counterpart: TxnRow | null }[];
  /** Set when `main` is the counterpart of a split line: that split and line, which own its amount and date. */
  owner: { parent: TxnRow; line: LineRow } | null;
}

async function row(db: Executor, id: string): Promise<TxnRow | null> {
  const [found] = await db.select().from(transaction).where(eq(transaction.id, id));
  return found ?? null;
}

/** The live transaction `id` with its transfer side, split lines and line counterparts (404 when there is none). */
export async function loadAggregate(db: Executor, id: string): Promise<Aggregate> {
  const main = await row(db, id);
  if (!main || main.deletedAt) throw new AppError(404, 'not_found', 'Transaction not found.');
  if (main.transferSubtxnId) {
    const [line] = await db.select().from(subtransaction).where(eq(subtransaction.id, main.transferSubtxnId));
    const parent = (await row(db, main.transferTxnId!))!;
    return { main, counterpart: null, lines: [], owner: { parent, line: line! } };
  }
  const counterpart = !main.isSplit && main.transferTxnId ? await row(db, main.transferTxnId) : null;
  const lineRows = main.isSplit
    ? await db
        .select()
        .from(subtransaction)
        .where(and(eq(subtransaction.txnId, id), isNull(subtransaction.deletedAt)))
        .orderBy(asc(subtransaction.sortOrder), asc(subtransaction.id))
    : [];
  const counterpartIds = lineRows.flatMap((line) => (line.transferTxnId ? [line.transferTxnId] : []));
  const counterparts =
    counterpartIds.length === 0
      ? []
      : await db.select().from(transaction).where(inArray(transaction.id, counterpartIds));
  return {
    main,
    counterpart,
    lines: lineRows.map((line) => ({
      line,
      counterpart: counterparts.find((c) => c.id === line.transferTxnId) ?? null,
    })),
    owner: null,
  };
}

/**
 * The saved transaction as a draft. The category of a budget↔tracking transfer (or transfer line) is the budget
 * side's, wherever it is stored.
 */
export function draftOf(agg: Aggregate): Draft {
  const { main, counterpart } = agg;
  return {
    accountId: main.accountId,
    date: main.date,
    payeeId: main.payeeId,
    categoryId: main.categoryId ?? counterpart?.categoryId ?? null,
    memo: main.memo,
    amount: main.amount,
    transferAmount: null,
    fxRate: null,
    cleared: main.cleared,
    approved: main.approved,
    flag: main.flag,
    lines: main.isSplit
      ? agg.lines.map(({ line, counterpart: other }) => ({
          amount: line.amount,
          payeeId: line.payeeId,
          categoryId: line.categoryId ?? other?.categoryId ?? null,
          memo: line.memo,
        }))
      : null,
  };
}

/**
 * Rates already stored on the transaction's rows, by currency (spec §9): edits keep them unless a new one is sent. A
 * manual rate always stays; an NBP rate only while the date does, so a new date books that day's NBP rate.
 */
export async function storedRates(db: Executor, agg: Aggregate, sameDate: boolean): Promise<Map<string, Rate>> {
  const rates = new Map<string, Rate>();
  for (const r of [agg.main, agg.counterpart]) {
    if (!r?.fxRate || (!r.fxRateManual && !sameDate)) continue;
    const [owner] = await db.select({ currency: account.currency }).from(account).where(eq(account.id, r.accountId));
    rates.set(owner!.currency, { rate: r.fxRate, manual: r.fxRateManual });
  }
  return rates;
}

/** Accounts that already hold rows of the transaction: closed ones among them keep those rows editable. */
export function accountsOf(agg: Aggregate): Set<string> {
  const rows = [agg.main, agg.counterpart, ...agg.lines.map((l) => l.counterpart)];
  return new Set(rows.flatMap((r) => (r ? [r.accountId] : [])));
}
