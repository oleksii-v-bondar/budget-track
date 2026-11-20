import { eq } from 'drizzle-orm';
import type { ChangeRecorder } from '../commands/recorder';
import { payee, scheduledSubtransaction, scheduledTransaction, subtransaction, transaction } from '../db/schema';
import type { Draft, LinePlan, Plan } from './plan';

/** Spec §10: the transaction sheet pre-fills the category from the payee. */
async function rememberCategory(rec: ChangeRecorder, plan: Plan): Promise<void> {
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
