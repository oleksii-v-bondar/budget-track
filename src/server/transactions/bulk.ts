import type { BulkAction, BulkRequest, UpdateTransactionRequest } from '../../shared/api/transactions';
import type { ChangeRecorder } from '../commands/recorder';
import { AppError } from '../http/errors';
import { loadAggregate } from './aggregate';
import { deleteTransaction, type EditContext, updateTransaction } from './transaction-commands';

const count = (n: number) => (n === 1 ? '1 transaction' : `${n} transactions`);

/** "Categorize 3 transactions", "Delete 1 transaction", … */
export function bulkLabel(request: BulkRequest): string {
  const n = count(request.ids.length);
  const { action } = request;
  switch (action.type) {
    case 'categorize':
      return `Categorize ${n}`;
    case 'setPayee':
      return `Set the payee of ${n}`;
    case 'setFlag':
      return action.flag === null ? `Remove the flag of ${n}` : `Flag ${n}`;
    case 'setCleared':
      return `Mark ${n} ${action.cleared}`;
    case 'approve':
      return `Approve ${n}`;
    case 'moveAccount':
      return `Move ${n}`;
    case 'delete':
      return `Delete ${n}`;
  }
}

/** The single-transaction edit an action stands for. */
function patchFor(
  action: Exclude<BulkAction, { type: 'delete' }>,
  confirmReconciled: boolean,
): UpdateTransactionRequest {
  switch (action.type) {
    case 'categorize':
      return { categoryId: action.categoryId, confirmReconciled };
    case 'setPayee':
      return { payeeId: action.payeeId, confirmReconciled };
    case 'setFlag':
      return { flag: action.flag, confirmReconciled };
    case 'setCleared':
      return { cleared: action.cleared, confirmReconciled };
    case 'approve':
      return { approved: true, confirmReconciled };
    case 'moveAccount':
      return { accountId: action.accountId, confirmReconciled };
  }
}

/**
 * Spec §10 "Search and bulk operations": applies the action to every selected transaction inside the caller's
 * command, re-checking every rule per row. A failure names the row (`ids.<index>`) and rolls everything back.
 * Deleting skips rows already deleted with an earlier selected row (the other side of a transfer, or a split
 * line's counterpart whose split is selected too).
 */
export async function bulkUpdate(rec: ChangeRecorder, request: BulkRequest, context: EditContext): Promise<void> {
  const { ids, action, confirmReconciled } = request;
  const selected = new Set(ids);
  const deleted = new Set<string>();
  for (const [index, id] of ids.entries()) {
    try {
      if (action.type !== 'delete') {
        await updateTransaction(rec, id, patchFor(action, confirmReconciled), context);
        continue;
      }
      if (deleted.has(id)) continue;
      const agg = await loadAggregate(rec.tx, id);
      if (agg.owner && selected.has(agg.owner.parent.id)) continue;
      const result = await deleteTransaction(rec, id, { now: context.now, confirmReconciled });
      for (const gone of result.ids) deleted.add(gone);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      throw new AppError(err.status, err.code, err.message, { fieldErrors: { [`ids.${index}`]: [err.message] } });
    }
  }
}
