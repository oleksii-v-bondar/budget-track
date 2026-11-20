import type { CreateTransactionRequest } from '../../shared/api/transactions';
import type { IsoDate } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import { DomainError } from '../http/errors';
import { findOrCreatePayee } from '../payees/payee-commands';
import { type Draft, planTransaction } from './plan';
import { insertPlan, insertSchedule } from './write';

export interface SavedTransaction {
  kind: 'transaction' | 'scheduled';
  /** The transaction's id, or the schedule's. */
  id: string;
  date: IsoDate;
  /** For the undo label. */
  payeeName: string | null;
}

/** "Add transaction "Biedronka"" / "Schedule transaction "Biedronka"" */
export function savedLabel(saved: SavedTransaction): string {
  const verb = saved.kind === 'scheduled' ? 'Schedule transaction' : 'Add transaction';
  return saved.payeeName === null ? verb : `${verb} "${saved.payeeName}"`;
}

/**
 * Spec §10 "Creating and editing": manual transactions are approved; a new payee name creates the payee; a date
 * after today becomes a one-time scheduled transaction (spec §5.6).
 */
export async function createTransaction(
  rec: ChangeRecorder,
  input: CreateTransactionRequest,
  today: IsoDate,
): Promise<SavedTransaction> {
  const payeeId =
    input.payeeName === undefined ? (input.payeeId ?? null) : await findOrCreatePayee(rec, input.payeeName);
  const draft: Draft = {
    accountId: input.accountId,
    date: input.date ?? today,
    payeeId,
    categoryId: input.categoryId,
    memo: input.memo || null,
    amount: input.amount,
    transferAmount: input.transferAmount ?? null,
    fxRate: input.fxRate ?? null,
    cleared: input.cleared,
    approved: true,
    flag: input.flag,
  };
  const plan = await planTransaction(rec.tx, draft);
  const payeeName = plan.payee?.name ?? null;
  if (draft.date > today) {
    if (plan.transfer && plan.transfer.currency !== plan.account.currency) {
      // A schedule has no column for the other side's amount.
      throw new DomainError(
        'future_transfer_currency',
        "Transfers between currencies can't be dated in the future yet.",
        'date',
      );
    }
    return { kind: 'scheduled', id: await insertSchedule(rec, draft, plan), date: draft.date, payeeName };
  }
  return { kind: 'transaction', id: await insertPlan(rec, plan), date: draft.date, payeeName };
}
