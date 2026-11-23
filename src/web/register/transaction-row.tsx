import type { FlagColor, TransactionDto } from '../../shared/api/transactions';
import { formatMoney } from '../lib/format';
import { cx } from '../ui/cx';
import { ClearedIcon, FlagIcon, LockIcon } from '../ui/icons';
import { categoryLabel, payeeLabel } from './register-days';

export const FLAG_CLASSES: Record<FlagColor, string> = {
  red: 'text-red-500',
  orange: 'text-orange-500',
  yellow: 'text-yellow-500',
  green: 'text-green-600',
  blue: 'text-blue-500',
  purple: 'text-purple-500',
};

/** Spec §11 Register: icons for the flag, an unapproved row, and the cleared or reconciled state. */
export function StatusIcons({ transaction }: { transaction: TransactionDto }) {
  const { flag, approved, cleared } = transaction;
  return (
    <span className="flex items-center gap-1">
      {flag && (
        <span role="img" aria-label={`${flag[0]!.toUpperCase()}${flag.slice(1)} flag`} className={FLAG_CLASSES[flag]}>
          <FlagIcon className="size-4" fill="currentColor" />
        </span>
      )}
      {!approved && <span role="img" aria-label="Unapproved" className="size-2.5 rounded-full bg-blue-500" />}
      {cleared === 'reconciled' ? (
        <span role="img" aria-label="Reconciled" className="text-brand">
          <LockIcon className="size-4" />
        </span>
      ) : (
        <span
          role="img"
          aria-label={cleared === 'cleared' ? 'Cleared' : 'Uncleared'}
          className={cleared === 'cleared' ? 'text-brand' : 'text-gray-300'}
        >
          <ClearedIcon className="size-4" />
        </span>
      )}
    </span>
  );
}

export interface TransactionRowProps {
  transaction: TransactionDto;
  /** Whether the transaction's account is on the budget (for "Uncategorized"). */
  onBudget: boolean;
  /** The All accounts register names each row's account. */
  showAccount: boolean;
}

/** One register row: payee, category (and account, memo), amount and status icons. */
export function TransactionRow({ transaction, onBudget, showAccount }: TransactionRowProps) {
  const details = [showAccount && transaction.accountName, categoryLabel(transaction, onBudget), transaction.memo]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{payeeLabel(transaction)}</span>
        {details && <span className="block truncate text-sm text-gray-500">{details}</span>}
      </span>
      <span className="flex flex-col items-end gap-1">
        <span className={cx('tabular-nums whitespace-nowrap', transaction.amount > 0 && 'text-green-700')}>
          {formatMoney(transaction.amount, transaction.currency)}
        </span>
        <StatusIcons transaction={transaction} />
      </span>
    </div>
  );
}
