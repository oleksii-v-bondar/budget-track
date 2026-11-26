import { eq, inArray } from 'drizzle-orm';
import type { ChangeRecorder } from '../commands/recorder';
import { payee, scheduledSubtransaction, scheduledTransaction, subtransaction, transaction } from '../db/schema';
import type { Aggregate } from './aggregate';
import type { Draft, LinePlan, Plan } from './plan';

/** Spec §10: the transaction sheet pre-fills the category from the payee. */
export async function rememberCategory(rec: ChangeRecorder, plan: Plan): Promise<void> {
  if (!plan.payeeDefault) return;
  const { payeeId, categoryId } = plan.payeeDefault;
  await rec.update(payee, eq(payee.id, payeeId), { lastCategoryId: categoryId });
}

/**
 * Spec §10 "Splits": a transfer line's counterpart points at the split (`transfer_txn_id`) and the line
 * (`transfer_subtxn_id`); the line points back at it.
 */
export async function insertLines(rec: ChangeRecorder, txnId: string, lines: LinePlan[]): Promise<void> {
  for (const { counterpart, ...line } of lines) {
    const [row] = await rec.insert(subtransaction, { ...line, txnId });
    if (!counterpart) continue;
    const [other] = await rec.insert(transaction, { ...counterpart, transferTxnId: txnId, transferSubtxnId: row!.id });
    await rec.update(subtransaction, eq(subtransaction.id, row!.id), { transferTxnId: other!.id });
  }
}

/**
 * Writes a new transaction from its plan; returns its id. The two sides of a transfer point at each other through
 * `transfer_txn_id` (inserted first, then linked, because the foreign keys are checked immediately).
 */
export async function insertPlan(rec: ChangeRecorder, plan: Plan): Promise<string> {
  const [main] = await rec.insert(transaction, plan.main);
  const id = main!.id;
  if (plan.counterpart) {
    const [other] = await rec.insert(transaction, { ...plan.counterpart, transferTxnId: id });
    await rec.update(transaction, eq(transaction.id, id), { transferTxnId: other!.id });
  }
  if (plan.lines) await insertLines(rec, id, plan.lines);
  await rememberCategory(rec, plan);
  return id;
}

/**
 * Spec §5.6: a transaction dated after today is stored as a one-time scheduled transaction instead (anchor and next
 * date = its date). P2d's job enters it on that day and computes its PLN amount then. A transfer keeps the category
 * as entered; entering it puts the category on the budget side.
 */
export async function insertSchedule(rec: ChangeRecorder, draft: Draft, plan: Plan): Promise<string> {
  const [schedule] = await rec.insert(scheduledTransaction, {
    accountId: draft.accountId,
    payeeId: draft.payeeId,
    categoryId: draft.categoryId,
    memo: draft.memo,
    amount: draft.amount,
    fxRate: plan.main.fxRate,
    fxRateManual: plan.main.fxRateManual,
    flag: draft.flag,
    transferAccountId: plan.main.transferAccountId,
    isSplit: plan.main.isSplit,
    frequency: 'once',
    anchorDate: draft.date,
    nextDate: draft.date,
  });
  for (const [index, line] of (draft.lines ?? []).entries()) {
    await rec.insert(scheduledSubtransaction, {
      ...line,
      scheduledId: schedule!.id,
      transferAccountId: plan.lines![index]!.transferAccountId,
      sortOrder: index,
    });
  }
  await rememberCategory(rec, plan);
  return schedule!.id;
}

/** Soft-deletes transactions (spec §13); their lines stay, and the ledger view drops them with their split. */
export async function softDelete(rec: ChangeRecorder, ids: string[], now: Date): Promise<void> {
  if (ids.length > 0) await rec.update(transaction, inArray(transaction.id, ids), { deletedAt: now });
}

/** Soft-deletes a split's live lines and the counterparts of its transfer lines; returns the counterparts' ids. */
async function softDeleteLines(rec: ChangeRecorder, agg: Aggregate, now: Date): Promise<string[]> {
  const ids = agg.lines.map(({ line }) => line.id);
  if (ids.length > 0) await rec.update(subtransaction, inArray(subtransaction.id, ids), { deletedAt: now });
  const counterparts = agg.lines.flatMap(({ counterpart }) => (counterpart ? [counterpart.id] : []));
  await softDelete(rec, counterparts, now);
  return counterparts;
}

/**
 * Makes `other`, a plain row already in the transfer's other account (a bank import, an entry made by hand), the
 * other side of the transfer that the plain transaction `agg.main` becomes, instead of creating a new side. It takes
 * the plan's side and keeps its own cleared, approved and flag, its import id and its `bank_import`, so the bank's
 * copy is never imported again.
 */
export async function linkPlan(rec: ChangeRecorder, agg: Aggregate, plan: Plan, other: { id: string }): Promise<void> {
  await rec.update(transaction, eq(transaction.id, agg.main.id), { ...plan.main, transferTxnId: other.id });
  await rec.update(transaction, eq(transaction.id, other.id), { ...plan.counterpart!, transferTxnId: agg.main.id });
}

/**
 * Brings a saved transaction's rows in line with its new plan. A transfer side in the same account is updated in
 * place (keeping its cleared, approved and flag); a transfer that moves to another account, or stops being one,
 * loses its old side, and a new side is created. Split lines are updated in place, unless `replaceLines` is set:
 * then the old lines and their counterparts are soft-deleted and the plan's lines are created. Returns the ids of
 * the transactions it soft-deleted.
 */
export async function syncPlan(
  rec: ChangeRecorder,
  agg: Aggregate,
  plan: Plan,
  now: Date,
  replaceLines: boolean,
): Promise<string[]> {
  const id = agg.main.id;
  const old = agg.counterpart;
  const next = plan.counterpart;
  const deleted: string[] = [];
  if (old && next && old.accountId === next.accountId) {
    await rec.update(transaction, eq(transaction.id, id), plan.main);
    await rec.update(transaction, eq(transaction.id, old.id), next);
  } else {
    if (old) {
      await softDelete(rec, [old.id], now);
      deleted.push(old.id);
    }
    await rec.update(transaction, eq(transaction.id, id), { ...plan.main, transferTxnId: null });
    if (next) {
      const [other] = await rec.insert(transaction, { ...next, transferTxnId: id });
      await rec.update(transaction, eq(transaction.id, id), { transferTxnId: other!.id });
    }
  }
  if (replaceLines) {
    deleted.push(...(await softDeleteLines(rec, agg, now)));
    if (plan.lines) await insertLines(rec, id, plan.lines);
    return deleted;
  }
  for (const [index, { line, counterpart }] of agg.lines.entries()) {
    const { counterpart: nextCounterpart, ...nextLine } = plan.lines![index]!;
    await rec.update(subtransaction, eq(subtransaction.id, line.id), nextLine);
    if (counterpart && nextCounterpart) {
      await rec.update(transaction, eq(transaction.id, counterpart.id), nextCounterpart);
    }
  }
  return deleted;
}
