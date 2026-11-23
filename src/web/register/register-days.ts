import type { TransactionDto } from '../../shared/api/transactions';

export interface RegisterDay<T> {
  date: string;
  items: T[];
}

/** Spec §11 Register: rows grouped by date, keeping their order (newest first, as the server sends them). */
export function groupByDate<T extends { date: string }>(items: readonly T[]): RegisterDay<T>[] {
  const days: RegisterDay<T>[] = [];
  for (const item of items) {
    const last = days.at(-1);
    if (last?.date === item.date) last.items.push(item);
    else days.push({ date: item.date, items: [item] });
  }
  return days;
}

/** The payee column: the payee, or the other account of a transfer. */
export function payeeLabel(transaction: TransactionDto): string {
  return transaction.payeeName ?? (transaction.transfer ? `Transfer : ${transaction.transfer.accountName}` : 'No payee');
}

/**
 * The category column: a split's line count, the category, or "Uncategorized" for a budget transaction that counts
 * as such (spec §3: not a transfer or a starting balance); nothing for tracking accounts and plain transfers.
 */
export function categoryLabel(transaction: TransactionDto, onBudget: boolean): string | null {
  if (transaction.isSplit) return `Split (${transaction.lines.length})`;
  if (transaction.categoryName) return transaction.categoryName;
  if (onBudget && !transaction.transfer && !transaction.isStartingBalance) return 'Uncategorized';
  return null;
}
