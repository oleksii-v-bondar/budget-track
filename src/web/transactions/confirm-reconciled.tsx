import { ApiError } from '../lib/api';
import { Button } from '../ui/button';

/** Spec §13: the server answers 409 `confirm_reconciled` until a change to reconciled transactions is confirmed. */
export function needsConfirmation(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'confirm_reconciled';
}

/** Asks before resending with `confirmReconciled: true`. */
export function ConfirmReconciled({ onConfirm, busy }: { onConfirm: () => void; busy: boolean }) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-xl bg-yellow-50 p-3 text-yellow-900">
      <p>This changes reconciled transactions, which already match your bank statement. Change them anyway?</p>
      <Button variant="danger" mutating busy={busy} onClick={onConfirm}>
        Change anyway
      </Button>
    </div>
  );
}
