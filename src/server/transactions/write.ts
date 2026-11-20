import { eq } from 'drizzle-orm';
import type { ChangeRecorder } from '../commands/recorder';
import { payee, scheduledTransaction, transaction } from '../db/schema';
import type { Draft, Plan } from './plan';

/** Spec §10: the transaction sheet pre-fills the category from the payee. */
async function rememberCategory(rec: ChangeRecorder, plan: Plan): Promise<void> {
  if (!plan.payeeDefault) return;
  const { payeeId, categoryId } = plan.payeeDefault;
  await rec.update(payee, eq(payee.id, payeeId), { lastCategoryId: categoryId });
}

/** Writes a new transaction from its plan; returns its id. */
export async function insertPlan(rec: ChangeRecorder, plan: Plan): Promise<string> {
  const [main] = await rec.insert(transaction, plan.main);
  await rememberCategory(rec, plan);
  return main!.id;
}

/**
 * Spec §5.6: a transaction dated after today is stored as a one-time scheduled transaction instead (anchor and next
 * date = its date). P2d's job enters it on that day and computes its PLN amount then.
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
    frequency: 'once',
    anchorDate: draft.date,
    nextDate: draft.date,
  });
  await rememberCategory(rec, plan);
  return schedule!.id;
}
