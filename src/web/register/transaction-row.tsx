import type { FlagColor, TransactionDto } from '../../shared/api/transactions';
import { formatMoney } from '../lib/format';
import { cx } from '../ui/cx';
import { CategoryNeededIcon, FlagIcon, LockIcon } from '../ui/icons';
import { categoryLabel, needsCategory, payeeLabel } from './register-days';

export const FLAG_CLASSES: Record<FlagColor, string> = {
  red: 'text-red-500',
  orange: 'text-orange-500',
  yellow: 'text-yellow-500',
  green: 'text-green-600',
  blue: 'text-blue-500',
  purple: 'text-purple-500',
};

/** Spec §11 Register: icons for the flag, an unapproved row, and the cleared ("c", green when cleared) or reconciled state. */
export function StatusIcons({ transaction }: { transaction: TransactionDto }) {
  const { flag, approved, cleared } = transaction;
  return (
    <span className="flex items-center gap-1.5">
      {flag && (
        <span role="img" aria-label={`${flag[0]!.toUpperCase()}${flag.slice(1)} flag`} className={FLAG_CLASSES[flag]}>
          <FlagIcon className="size-4" fill="currentColor" />
        </span>
      )}
      {!approved && <span role="img" aria-label="Unapproved" className="size-2.5 rounded-full bg-brand" />}
      {cleared === 'reconciled' ? (
        <span role="img" aria-label="Reconciled" className="text-lime">
          <LockIcon className="size-4" />
        </span>
      ) : (
        <span role="img" aria-label={cleared === 'cleared' ? 'Cleared' : 'Uncleared'}>
          <svg viewBox="0 0 18 18" className="size-[18px]" aria-hidden="true">
            <circle cx="9" cy="9" r="9" className={cleared === 'cleared' ? 'fill-lime' : 'fill-zero'} />
            <path
              d="M11.6 6.6a3.4 3.4 0 1 0 0 4.8"
              fill="none"
              strokeWidth="2.2"
              strokeLinecap="round"
              className={cleared === 'cleared' ? 'stroke-page' : 'stroke-muted'}
            />
          </svg>
        </span>
      )}
    </span>
  );
}

/** A bank import the bank hasn't booked yet. */
export function PendingChip() {
  return <span className="shrink-0 rounded-md bg-zero px-1.5 py-0.5 text-xs text-muted italic">Pending</span>;
}

export interface TransactionRowProps {
  transaction: TransactionDto;
  /** Whether the transaction's account is on the budget (for "Category Needed"). */
  onBudget: boolean;
  /** Spending (all accounts) names each row's account under the amount. */
  showAccount: boolean;
}

/**
 * One Spending or register row: the payee ("Pending" beside it while the bank hasn't booked it), its category in a
 * chip ("Category Needed" in yellow, with a yellow edge, when a budget transaction has none) and the memo; the amount,
 * the status icons and the account.
 */
export function TransactionRow({ transaction, onBudget, showAccount }: TransactionRowProps) {
  const missing = needsCategory(transaction, onBudget);
  const label = categoryLabel(transaction, onBudget);
  return (
    <div className={cx('flex gap-3 border-l-4 py-3 pr-4 pl-3', missing ? 'border-yellow-400' : 'border-transparent')}>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[17px] font-semibold">{payeeLabel(transaction)}</span>
          {transaction.bankPending && <PendingChip />}
        </span>
        {(label || transaction.memo) && (
          <span className="mt-1.5 flex min-w-0 items-center gap-2">
            {missing ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-yellow-400/15 px-2.5 py-1 text-[15px] text-yellow-300">
                <CategoryNeededIcon className="size-4" />
                Category Needed
              </span>
            ) : (
              label && <span className="min-w-0 truncate rounded-lg bg-raised px-2.5 py-1 text-[15px]">{label}</span>
            )}
            {transaction.memo && <span className="min-w-0 truncate text-sm text-muted">{transaction.memo}</span>}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="flex items-center gap-1.5">
          <span
            className={cx(
              'text-[17px] font-semibold whitespace-nowrap tabular-nums',
              transaction.amount > 0 && 'text-lime',
            )}
          >
            {formatMoney(transaction.amount, transaction.currency)}
          </span>
          <StatusIcons transaction={transaction} />
        </span>
        {showAccount && <span className="max-w-36 truncate text-[15px] text-muted">{transaction.accountName}</span>}
      </span>
    </div>
  );
}
