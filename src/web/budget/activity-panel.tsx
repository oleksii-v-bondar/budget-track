import { useInfiniteQuery } from '@tanstack/react-query';
import { daysInMonth } from '../../engine/dates';
import type { BudgetCategoryDto } from '../../shared/api/budget';
import type { TransactionDto } from '../../shared/api/transactions';
import { api, unwrap } from '../lib/api';
import { errorMessage } from '../lib/commands';
import { formatDate, formatMoney, formatMonth } from '../lib/format';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';

const PAGE_SIZE = '100';

/** Which register rows make up a category's activity: a card payment category's are its card's (spec §5.3). */
function registerFilter(category: BudgetCategoryDto): { accountId: string } | { categoryId: string } {
  return category.kind === 'cc_payment' && category.linkedAccountId
    ? { accountId: category.linkedAccountId }
    : { categoryId: category.id };
}

/** The PLN amount a row adds to the category: a split's lines in it, or the whole transaction. */
export function amountIn(transaction: TransactionDto, filter: { accountId: string } | { categoryId: string }): number {
  if (!('categoryId' in filter) || !transaction.isSplit) return transaction.amountBase;
  return transaction.lines
    .filter((line) => line.categoryId === filter.categoryId)
    .reduce((sum, line) => sum + line.amountBase, 0);
}

/**
 * Spec §11 Activity: the transactions behind this month's activity, from the register (newest first, 100 at a time).
 * A card payment category lists its card's transactions of the month.
 */
export function ActivityPanel({ month, category }: { month: string; category: BudgetCategoryDto }) {
  const filter = registerFilter(category);
  const range = { from: `${month}-01`, to: `${month}-${String(daysInMonth(month)).padStart(2, '0')}` };
  const register = useInfiniteQuery({
    queryKey: ['transactions', { ...filter, ...range }],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.api.transactions.$get({
          query: { ...filter, ...range, limit: PAGE_SIZE, ...(pageParam === null ? {} : { cursor: pageParam }) },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

  if (register.isPending) return <p className="py-4 text-center text-muted">Loading the transactions…</p>;
  if (register.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <p className="text-gray-200">{errorMessage(register.error)}</p>
        <Button variant="secondary" onClick={() => void register.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  const transactions = register.data.pages.flatMap((page) => page.transactions);
  if (transactions.length === 0) {
    return <p className="py-4 text-center text-muted">No transactions in {formatMonth(month)}.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {'accountId' in filter && (
        <p className="text-sm text-muted">Spending and payments on this card in {formatMonth(month)}.</p>
      )}
      <ul aria-label="Transactions" className="divide-y divide-line">
        {transactions.map((transaction) => {
          const amount = amountIn(transaction, filter);
          return (
            <li key={transaction.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{transaction.payeeName ?? 'No payee'}</p>
                <p className="truncate text-xs text-muted">
                  {[formatDate(transaction.date), transaction.accountName, transaction.isSplit && 'Split', transaction.memo]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <span className={cx('tabular-nums', amount > 0 ? 'text-lime' : 'text-white')}>{formatMoney(amount)}</span>
            </li>
          );
        })}
      </ul>
      {register.hasNextPage && (
        <Button variant="secondary" busy={register.isFetchingNextPage} onClick={() => void register.fetchNextPage()}>
          Show more
        </Button>
      )}
    </div>
  );
}
