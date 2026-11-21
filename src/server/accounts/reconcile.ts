import { and, eq, isNull } from 'drizzle-orm';
import { BASE_CURRENCY, type ReconcileRequest, type ReconcileStatusDto } from '../../shared/api/accounts';
import type { IsoDate } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { systemCategoryId, systemPayeeId } from '../db/lookups';
import { account, transaction } from '../db/schema';
import { AppError, DomainError } from '../http/errors';
import { planTransaction } from '../transactions/plan';
import { assertBaseAmount } from '../transactions/rules';
import { insertPlan } from '../transactions/write';
import { getAccount } from './account-queries';

/** Spec §10 "Reconcile flow": the account's cleared balance in its own currency, and its last reconciliation. */
export async function reconcileStatus(db: Executor, id: string): Promise<ReconcileStatusDto> {
  const current = await getAccount(db, id);
  return {
    accountId: current.id,
    currency: current.currency,
    clearedBalance: current.balance.cleared,
    lastReconciledAt: current.lastReconciledAt,
    lastReconciledBalance: current.lastReconciledBalance,
  };
}

export interface ReconcileContext {
  today: IsoDate;
  now: Date;
  /** Spec §9: today's NBP rate for a foreign adjustment, quoted before the command. */
  defaults: Map<string, string>;
}

/**
 * Spec §10 "Reconcile flow", in the account's currency: when the statement matches the cleared balance, every cleared
 * transaction becomes reconciled and the account remembers when and at what balance. A difference is refused
 * (`reconcile_mismatch`, with the difference) unless `createAdjustment` is set: then a cleared "Reconciliation Balance
 * Adjustment" dated today books it first (Ready to Assign on budget accounts, no category on tracking ones; a
 * foreign amount at the rate sent or today's NBP rate). Its PLN amount stays within ±MAX_BASE_AMOUNT (spec §4.4;
 * `amount_too_large` on `statementBalance`). Later edits of reconciled rows need confirmation (P2c).
 */
export async function reconcileAccount(
  rec: ChangeRecorder,
  id: string,
  input: ReconcileRequest,
  context: ReconcileContext,
): Promise<{ name: string; adjustmentId: string | null; reconciledCount: number }> {
  const current = await getAccount(rec.tx, id);
  if (current.closed) {
    throw new DomainError('account_closed', `"${current.name}" is closed. Reopen it to reconcile it.`);
  }
  const difference = input.statementBalance - current.balance.cleared;
  let adjustmentId: string | null = null;
  if (difference !== 0) {
    if (!input.createAdjustment) {
      throw new AppError(
        422,
        'reconcile_mismatch',
        "The cleared balance doesn't match the statement. Review the transactions, or create an adjustment.",
        { difference },
      );
    }
    if (current.currency === BASE_CURRENCY) assertBaseAmount(difference, 'statementBalance');
    const draft = {
      accountId: id,
      date: context.today,
      payeeId: await systemPayeeId(rec.tx, 'reconciliation_adjustment'),
      categoryId: current.accountClass === 'tracking' ? null : await systemCategoryId(rec.tx, 'rta'),
      memo: null,
      amount: difference,
      transferAmount: null,
      fxRate: input.fxRate ?? null,
      cleared: 'cleared' as const,
      approved: true,
      flag: null,
      lines: null,
    };
    const plan = await planTransaction(rec.tx, draft, { defaults: context.defaults, systemPayee: true }).catch(
      (err: unknown) => {
        // The planner names the draft's `amount`; the statement balance is what the user sent.
        if (err instanceof DomainError && err.code === 'amount_too_large') {
          throw new DomainError(err.code, err.message, 'statementBalance');
        }
        throw err;
      },
    );
    adjustmentId = await insertPlan(rec, plan);
  }
  const reconciled = await rec.update(
    transaction,
    and(eq(transaction.accountId, id), eq(transaction.cleared, 'cleared'), isNull(transaction.deletedAt)),
    { cleared: 'reconciled' },
  );
  await rec.update(account, eq(account.id, id), {
    lastReconciledAt: context.now,
    lastReconciledBalance: input.statementBalance,
  });
  return { name: current.name, adjustmentId, reconciledCount: reconciled.length };
}
