import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { AccountBalances, AccountDto } from '../../shared/api/accounts';
import type { TransactionDto } from '../../shared/api/transactions';
import { ACCOUNT_TYPE_LABELS, isForeign, isOnBudget } from '../accounts/account-groups';
import { AccountSettings } from '../accounts/account-settings';
import { ReconcileForm } from '../accounts/reconcile';
import { RevalueForm } from '../accounts/revalue';
import { accountsQuery } from '../accounts/accounts-api';
import { formatDate, formatMoney } from '../lib/format';
import { categoriesQuery, payeesQuery } from '../transactions/lookups';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { CloseIcon } from '../ui/icons';
import { LoadError, Loading } from '../ui/load-state';
import { Sheet } from '../ui/sheet';
import { BulkActions } from './bulk-actions';
import { FilterForm } from './filter-form';
import { filterChips, type RegisterFilters, registerParams } from './filters';
import { registerQuery } from './register-api';
import { groupByDate, payeeLabel } from './register-days';
import { TransactionRow } from './transaction-row';

function Balance({ label, minor, currency }: { label: string; minor: number; currency: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={cx('font-semibold tabular-nums whitespace-nowrap', minor < 0 && 'text-red-600')}>
        {formatMoney(minor, currency)}
      </dd>
    </div>
  );
}

/** The register header's actions: compact, in one row that scrolls sideways on a narrow phone. */
const HEADER_ACTION =
  'inline-flex min-h-9 shrink-0 items-center rounded-full bg-gray-100 px-3 text-sm font-semibold text-gray-800 hover:bg-gray-200';

/** Spec §11 Register header: the account's cleared, uncleared and working balance, in its currency. */
function RegisterHeader({ account, balance }: { account: AccountDto; balance: AccountBalances }) {
  const [open, setOpen] = useState<'edit' | 'reconcile' | 'revalue' | null>(null);
  const close = () => setOpen(null);
  const navigate = useNavigate();
  return (
    <section aria-label="Balances" className="border-b border-gray-200 bg-white px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="truncate text-xl font-semibold">{account.name}</h2>
        <span className="shrink-0 text-sm text-gray-500">
          {ACCOUNT_TYPE_LABELS[account.type]}
          {account.closed && ' · Closed'}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        <Balance label="Cleared" minor={balance.cleared} currency={account.currency} />
        <Balance label="Uncleared" minor={balance.uncleared} currency={account.currency} />
        <Balance label="Working" minor={balance.working} currency={account.currency} />
      </dl>
      {isForeign(account) && account.balanceAtLatestRate !== null && (
        <p className="mt-1 text-right text-sm text-gray-500">≈ {formatMoney(account.balanceAtLatestRate)}</p>
      )}
      <div className="mt-3 flex gap-2 overflow-x-auto">
        {!account.closed && (
          <button type="button" className={HEADER_ACTION} onClick={() => setOpen('reconcile')}>
            Reconcile
          </button>
        )}
        {!account.closed && isForeign(account) && (
          <button type="button" className={HEADER_ACTION} onClick={() => setOpen('revalue')}>
            Revalue
          </button>
        )}
        <button type="button" className={HEADER_ACTION} onClick={() => setOpen('edit')}>
          Edit account
        </button>
      </div>
      <Sheet open={open === 'edit'} onClose={close} title="Edit account">
        <AccountSettings account={account} onDone={close} onDeleted={() => void navigate({ to: '/accounts' })} />
      </Sheet>
      <Sheet open={open === 'reconcile'} onClose={close} title={`Reconcile ${account.name}`}>
        <ReconcileForm account={account} onDone={close} />
      </Sheet>
      <Sheet open={open === 'revalue'} onClose={close} title={`Revalue ${account.name}`}>
        <RevalueForm account={account} onDone={close} />
      </Sheet>
    </section>
  );
}

/** Asks for the next page when it scrolls into view; the button does the same by hand (and in tests). */
function LoadMore({ onLoad, busy }: { onLoad: () => void; busy: boolean }) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onLoad(), {
      rootMargin: '400px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onLoad]);
  return (
    <div ref={sentinel} className="flex justify-center py-4">
      <Button variant="ghost" busy={busy} onClick={onLoad}>
        Load more
      </Button>
    </div>
  );
}

/** Filters and Select beside the search box (the kit's Button is taller). */
const TOOLBAR_BUTTON =
  'min-h-10 shrink-0 rounded-xl bg-white px-3 text-sm font-semibold text-gray-900 ring-1 ring-gray-300 hover:bg-gray-50';

/** Spec §10: search text (payee, memo, category) and the filter sheet, with the active filters as removable chips. */
function RegisterToolbar({
  filters,
  onFiltersChange,
  onSelect,
}: {
  filters: RegisterFilters;
  onFiltersChange: (filters: RegisterFilters) => void;
  /** Starts choosing transactions for a bulk action. */
  onSelect: () => void;
}) {
  const [text, setText] = useState(filters.q ?? '');
  const [open, setOpen] = useState(false);
  const categories = useQuery(categoriesQuery);
  const payees = useQuery(payeesQuery);
  const lookups = { groups: categories.data?.groups ?? [], payees: payees.data?.payees ?? [] };
  const chips = filterChips(filters, lookups);
  const search = (q: string) => onFiltersChange({ ...filters, q: q.trim() === '' ? undefined : q.trim() });
  return (
    <div className="flex flex-col gap-2 border-b border-gray-200 bg-white px-4 py-2">
      <div className="flex gap-2">
        <form
          role="search"
          className="flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            search(text);
          }}
        >
          <input
            type="search"
            aria-label="Search transactions"
            placeholder="Search payee, memo, category"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (event.target.value === '' && filters.q) search('');
            }}
            className="min-h-10 w-full rounded-xl border border-gray-300 bg-gray-50 px-3 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
          />
        </form>
        <button type="button" className={TOOLBAR_BUTTON} onClick={() => setOpen(true)}>
          Filters{chips.length > 0 && ` (${chips.length})`}
        </button>
        <button type="button" className={TOOLBAR_BUTTON} onClick={onSelect}>
          Select
        </button>
      </div>
      {chips.length > 0 && (
        <ul aria-label="Active filters" className="flex flex-wrap gap-2">
          {chips.map((chip) => (
            <li key={chip.key}>
              <button
                type="button"
                aria-label={`Remove the filter ${chip.label}`}
                onClick={() => onFiltersChange({ ...filters, [chip.key]: undefined })}
                className="flex min-h-8 items-center gap-1 rounded-full bg-brand-light px-3 text-sm font-medium text-brand-dark"
              >
                {chip.label}
                <CloseIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="Filters">
        <FilterForm
          filters={filters}
          groups={lookups.groups}
          payees={lookups.payees}
          onApply={(next) => {
            setOpen(false);
            onFiltersChange(next);
          }}
        />
      </Sheet>
    </div>
  );
}

/** While choosing transactions for a bulk action: which are chosen. */
interface Selection {
  ids: Set<string>;
  toggle: (id: string) => void;
}

/** The bar that stands in for the bottom navigation's top edge while transactions are being chosen. */
function BulkBar({
  selected,
  loaded,
  accounts,
  onSelectAll,
  onDone,
}: {
  selected: TransactionDto[];
  loaded: number;
  accounts: AccountDto[];
  onSelectAll: () => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const categories = useQuery(categoriesQuery);
  const payees = useQuery(payeesQuery);
  const n = selected.length;
  return (
    <div
      role="toolbar"
      aria-label="Selected transactions"
      className="fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-20 mx-auto flex max-w-[480px] items-center gap-2 border-t border-gray-200 bg-white px-4 py-2 shadow-lg"
    >
      <span className="flex-1 font-medium">{n} selected</span>
      {n < loaded && (
        <Button variant="ghost" className="min-h-9 px-2 text-sm" onClick={onSelectAll}>
          Select all
        </Button>
      )}
      <Button className="min-h-9 px-3 text-sm" disabled={n === 0} onClick={() => setOpen(true)}>
        Actions
      </Button>
      <Button variant="secondary" className="min-h-9 px-3 text-sm" onClick={onDone}>
        Cancel
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={`Change ${n} transaction${n === 1 ? '' : 's'}`}>
        <BulkActions
          transactions={selected}
          accounts={accounts}
          groups={categories.data?.groups ?? []}
          payees={payees.data?.payees ?? []}
          onDone={() => {
            setOpen(false);
            onDone();
          }}
        />
      </Sheet>
    </div>
  );
}

interface RegisterListProps {
  transactions: TransactionDto[];
  accounts: Map<string, AccountDto>;
  showAccount: boolean;
  selection: Selection | null;
}

function RegisterList({ transactions, accounts, showAccount, selection }: RegisterListProps) {
  return groupByDate(transactions).map((day) => (
    <section key={day.date} aria-label={formatDate(day.date)}>
      <h3 className="bg-gray-100 px-4 py-1 text-xs font-semibold text-gray-500">{formatDate(day.date)}</h3>
      <ul className="divide-y divide-gray-100 bg-white">
        {day.items.map((transaction) => {
          const owner = accounts.get(transaction.accountId);
          const row = (
            <TransactionRow transaction={transaction} onBudget={owner ? isOnBudget(owner) : true} showAccount={showAccount} />
          );
          return (
            <li key={transaction.id}>
              {selection ? (
                <label className="flex items-center pl-4">
                  <input
                    type="checkbox"
                    className="size-5 shrink-0 accent-brand"
                    aria-label={`Select ${payeeLabel(transaction)} ${formatMoney(transaction.amount, transaction.currency)}`}
                    checked={selection.ids.has(transaction.id)}
                    onChange={() => selection.toggle(transaction.id)}
                  />
                  <span className="min-w-0 flex-1">{row}</span>
                </label>
              ) : (
                row
              )}
            </li>
          );
        })}
      </ul>
    </section>
  ));
}

/**
 * Spec §11 Register, for one account (`accountId`) or all of them: the balances header, then the transactions
 * grouped by date, newest first, loading more pages as the list scrolls (cursor pagination).
 */
export function RegisterScreen({
  accountId,
  filters,
  onFiltersChange,
}: {
  accountId?: string;
  filters: RegisterFilters;
  onFiltersChange: (filters: RegisterFilters) => void;
}) {
  const accounts = useQuery(accountsQuery);
  // While other filters load, the last results stay on screen.
  const register = useInfiniteQuery({ ...registerQuery(registerParams(accountId, filters)), placeholderData: keepPreviousData });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = register;
  const loadMore = () => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  };

  if (accounts.isPending) return <Loading />;
  if (accounts.isError) return <LoadError error={accounts.error} onRetry={() => void accounts.refetch()} />;
  const account = accountId === undefined ? null : accounts.data.accounts.find((a) => a.id === accountId);
  if (account === undefined) {
    return (
      <div className="px-4 py-12 text-center">
        <p className="font-medium">This account doesn't exist.</p>
        <Link to="/accounts" className="text-brand underline">
          Go to the accounts
        </Link>
      </div>
    );
  }

  const transactions = register.data?.pages.flatMap((page) => page.transactions) ?? [];
  const filtered = Object.values(filters).some((value) => value !== undefined);
  const byId = new Map(accounts.data.accounts.map((a) => [a.id, a]));
  let list;
  if (register.isPending) list = <Loading />;
  else if (register.isError) list = <LoadError error={register.error} onRetry={() => void register.refetch()} />;
  else if (transactions.length === 0) {
    list = (
      <p className="px-4 py-12 text-center text-gray-500">
        {filtered ? 'No transactions match.' : 'No transactions yet.'}
      </p>
    );
  }
  return (
    <div>
      {account && <RegisterHeader account={account} balance={register.data?.pages[0]?.balances?.balance ?? account.balance} />}
      <RegisterToolbar filters={filters} onFiltersChange={onFiltersChange} onSelect={() => setSelected(new Set())} />
      {list ?? (
        <RegisterList
          transactions={transactions}
          accounts={byId}
          showAccount={account === null}
          selection={selected && { ids: selected, toggle }}
        />
      )}
      {hasNextPage && <LoadMore onLoad={loadMore} busy={isFetchingNextPage} />}
      {selected && <div aria-hidden="true" className="h-24" />}
      {selected && (
        <BulkBar
          selected={transactions.filter((t) => selected.has(t.id))}
          loaded={transactions.length}
          accounts={accounts.data.accounts}
          // A bulk command takes at most 500 transactions.
          onSelectAll={() => setSelected(new Set(transactions.slice(0, 500).map((t) => t.id)))}
          onDone={() => setSelected(null)}
        />
      )}
    </div>
  );
}
