import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { AccountBalances, AccountDto } from '../../shared/api/accounts';
import type { TransactionDto } from '../../shared/api/transactions';
import { ACCOUNT_TYPE_LABELS, isForeign, isOnBudget } from '../accounts/account-groups';
import { AccountSettings } from '../accounts/account-settings';
import { ReconcileForm } from '../accounts/reconcile';
import { RevalueForm } from '../accounts/revalue';
import { accountsQuery } from '../accounts/accounts-api';
import { api, unwrap } from '../lib/api';
import { useCommand } from '../lib/commands';
import { formatDayHeading, formatMoney } from '../lib/format';
import { BackLink, PILL_BUTTON, ROUND_BUTTON, ScreenHeader } from '../shell/screen-header';
import { categoriesQuery, payeesQuery } from '../transactions/lookups';
import { TransactionForm } from '../transactions/transaction-form';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { FormError } from '../ui/field';
import { CloseIcon, SearchIcon } from '../ui/icons';
import { LoadError, Loading } from '../ui/load-state';
import { Sheet } from '../ui/sheet';
import { BulkActions, bulkErrorMessage } from './bulk-actions';
import { FilterForm } from './filter-form';
import { MarkTransfer } from './mark-transfer';
import { filterChips, type RegisterFilters, registerParams } from './filters';
import { registerQuery } from './register-api';
import { groupByDate, payeeLabel } from './register-days';
import { TransactionRow } from './transaction-row';

function Balance({ label, minor, currency }: { label: string; minor: number; currency: string }) {
  return (
    <div>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={cx('font-semibold tabular-nums whitespace-nowrap', minor < 0 && 'text-red-400')}>
        {formatMoney(minor, currency)}
      </dd>
    </div>
  );
}

/** The register header's actions: compact, in one row that scrolls sideways on a narrow phone. */
const HEADER_ACTION =
  'inline-flex min-h-10 shrink-0 items-center rounded-full bg-raised px-4 text-sm font-semibold text-white ring-1 ring-white/5 hover:bg-white/10';

/** Spec §11 Register header: the account's cleared, uncleared and working balance, in its currency. */
function RegisterHeader({ account, balance }: { account: AccountDto; balance: AccountBalances }) {
  const [open, setOpen] = useState<'edit' | 'reconcile' | 'revalue' | null>(null);
  const close = () => setOpen(null);
  const navigate = useNavigate();
  return (
    <section aria-label="Balances" className="px-4 pb-2">
      <h2 className="mt-4 truncate text-[34px] leading-tight font-bold tracking-tight">{account.name}</h2>
      <p className="text-muted">
        {ACCOUNT_TYPE_LABELS[account.type]}
        {account.closed && ' · Closed'}
      </p>
      <dl className="mt-3 grid grid-cols-3 gap-2 rounded-2xl bg-surface p-4">
        <Balance label="Cleared" minor={balance.cleared} currency={account.currency} />
        <Balance label="Uncleared" minor={balance.uncleared} currency={account.currency} />
        <Balance label="Working" minor={balance.working} currency={account.currency} />
      </dl>
      {isForeign(account) && account.balanceAtLatestRate !== null && (
        <p className="mt-1 text-right text-sm text-muted">≈ {formatMoney(account.balanceAtLatestRate)}</p>
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

/** The Filters button beside the search box (the kit's Button is taller). */
const FILTERS_BUTTON =
  'min-h-11 shrink-0 rounded-full bg-raised px-4 text-sm font-semibold text-white ring-1 ring-white/5 hover:bg-white/10';

/** Spec §10: search text (payee, memo, category) and the filter sheet, with the active filters as removable chips. */
function SearchBar({
  filters,
  open,
  onFiltersChange,
}: {
  filters: RegisterFilters;
  /** The search box and Filters are shown (the top bar's search button); the chips always are. */
  open: boolean;
  onFiltersChange: (filters: RegisterFilters) => void;
}) {
  const [text, setText] = useState(filters.q ?? '');
  const [sheet, setSheet] = useState(false);
  const categories = useQuery(categoriesQuery);
  const payees = useQuery(payeesQuery);
  const lookups = { groups: categories.data?.groups ?? [], payees: payees.data?.payees ?? [] };
  const chips = filterChips(filters, lookups);
  // The review bar stands for "Unapproved".
  const shown = chips.filter((chip) => chip.key !== 'unapproved');
  const search = (q: string) => onFiltersChange({ ...filters, q: q.trim() === '' ? undefined : q.trim() });
  if (!open && shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-4 pb-3">
      {open && (
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
              className="min-h-11 w-full rounded-full border border-line bg-raised px-4 text-base outline-none placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/30"
            />
          </form>
          <button type="button" className={FILTERS_BUTTON} onClick={() => setSheet(true)}>
            Filters{chips.length > 0 && ` (${chips.length})`}
          </button>
        </div>
      )}
      {shown.length > 0 && (
        <ul aria-label="Active filters" className="flex flex-wrap gap-2">
          {shown.map((chip) => (
            <li key={chip.key}>
              <button
                type="button"
                aria-label={`Remove the filter ${chip.label}`}
                onClick={() => onFiltersChange({ ...filters, [chip.key]: undefined })}
                className="flex min-h-8 items-center gap-1 rounded-full bg-brand-light px-3 text-sm font-medium text-indigo-200"
              >
                {chip.label}
                <CloseIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={sheet} onClose={() => setSheet(false)} title="Filters">
        <FilterForm
          filters={filters}
          groups={lookups.groups}
          payees={lookups.payees}
          onApply={(next) => {
            setSheet(false);
            onFiltersChange(next);
          }}
        />
      </Sheet>
    </div>
  );
}

/** "① N New transactions [Review]": shows only the unapproved ones (bank imports) to approve them. */
function ReviewBanner({ count, onReview }: { count: number; onReview: () => void }) {
  return (
    <div className="mx-4 mb-3 flex items-center gap-3 rounded-full bg-surface py-2 pr-2 pl-4">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-light text-sm font-bold text-indigo-200 tabular-nums">
        {count}
      </span>
      <span className="flex-1 text-[17px]">New transaction{count === 1 ? '' : 's'}</span>
      <button
        type="button"
        onClick={onReview}
        className="min-h-11 rounded-full bg-brand-light px-6 text-[17px] font-semibold text-brand hover:bg-brand-light/70"
      >
        Review
      </button>
    </div>
  );
}

/** While reviewing: approve every listed transaction, or stop reviewing. */
function ReviewBar({
  count,
  busy,
  onApproveAll,
  onDone,
}: {
  count: number;
  busy: boolean;
  onApproveAll: () => void;
  onDone: () => void;
}) {
  return (
    <div className="mx-4 mb-3 flex items-center gap-2 rounded-full bg-surface py-2 pr-2 pl-4">
      <span className="flex-1 text-[17px]">{count === 0 ? 'Nothing to review' : `${count} to review`}</span>
      {count > 0 && (
        <Button mutating busy={busy} className="min-h-10 px-4 text-sm" onClick={onApproveAll}>
          Approve all
        </Button>
      )}
      <Button variant="secondary" className="min-h-10 px-4 text-sm" onClick={onDone}>
        Done
      </Button>
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
      className="fixed inset-x-0 bottom-[calc(5.5rem+max(0.75rem,env(safe-area-inset-bottom)))] z-30 mx-auto flex max-w-[480px] items-center gap-2 rounded-t-3xl border-t border-line bg-surface px-4 py-3 shadow-2xl"
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
  onOpen: (transaction: TransactionDto) => void;
  selection: Selection | null;
  /** While reviewing: approves one transaction. */
  onApprove: ((transaction: TransactionDto) => void) | null;
  /** While reviewing: makes one a transfer to or from another account (and approves it). */
  onTransfer: (transaction: TransactionDto) => void;
}

function RegisterList({ transactions, accounts, showAccount, onOpen, selection, onApprove, onTransfer }: RegisterListProps) {
  return groupByDate(transactions).map((day) => (
    <section key={day.date} aria-label={formatDayHeading(day.date)}>
      <h3 className="px-4 pt-5 pb-2 text-lg font-semibold">{formatDayHeading(day.date)}</h3>
      <ul className="divide-y divide-line bg-surface">
        {day.items.map((transaction) => {
          const owner = accounts.get(transaction.accountId);
          const row = (
            <TransactionRow
              transaction={transaction}
              onBudget={owner ? isOnBudget(owner) : true}
              showAccount={showAccount}
            />
          );
          const name = `${payeeLabel(transaction)} ${formatMoney(transaction.amount, transaction.currency)}`;
          return (
            <li key={transaction.id} className="flex items-center">
              {selection ? (
                <label className="flex min-w-0 flex-1 items-center pl-4">
                  <input
                    type="checkbox"
                    className="size-5 shrink-0 accent-brand"
                    aria-label={`Select ${name}`}
                    checked={selection.ids.has(transaction.id)}
                    onChange={() => selection.toggle(transaction.id)}
                  />
                  <span className="min-w-0 flex-1">{row}</span>
                </label>
              ) : (
                <button
                  type="button"
                  className="block min-w-0 flex-1 text-left hover:bg-white/5"
                  onClick={() => onOpen(transaction)}
                >
                  {row}
                </button>
              )}
              {onApprove && !selection && !transaction.approved && (
                <span className="mr-4 flex shrink-0 flex-col gap-1.5">
                  <Button
                    mutating
                    aria-label={`Approve ${name}`}
                    className="min-h-9 px-3 text-sm"
                    onClick={() => onApprove(transaction)}
                  >
                    Approve
                  </Button>
                  {!transaction.transfer && !transaction.isSplit && !transaction.isStartingBalance && (
                    <Button
                      variant="secondary"
                      mutating
                      aria-label={`Mark ${name} as a transfer`}
                      className="min-h-9 px-3 text-sm"
                      onClick={() => onTransfer(transaction)}
                    >
                      Transfer…
                    </Button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  ));
}

/**
 * Spending (every account) and an account's register (spec §11, `accountId`): the top bar with search and Select,
 * the balances header of an account, the review banner, then the transactions grouped by date, newest first, loading
 * more pages as the list scrolls (cursor pagination).
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
  const register = useInfiniteQuery({
    ...registerQuery(registerParams(accountId, filters)),
    placeholderData: keepPreviousData,
  });
  // Open while a search or filter is on (reviewing has a bar of its own).
  const [searching, setSearching] = useState(() =>
    Object.entries(filters).some(([key, value]) => key !== 'unapproved' && value !== undefined),
  );
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [editing, setEditing] = useState<TransactionDto | null>(null);
  const [marking, setMarking] = useState<TransactionDto | null>(null);
  const approve = useCommand((ids: string[]) =>
    unwrap(api.api.transactions.bulk.$post({ json: { ids, action: { type: 'approve' }, confirmReconciled: false } })),
  );
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

  // Search and Select once the accounts are known (the rows need them).
  const header = (account: AccountDto | null, actions?: ReactNode) => (
    <ScreenHeader
      title={account ? undefined : 'Spending'}
      left={account && <BackLink to="/accounts" label="Accounts" />}
      actions={actions}
    />
  );
  if (accounts.isPending) {
    return (
      <>
        {header(null)}
        <Loading />
      </>
    );
  }
  if (accounts.isError) {
    return (
      <>
        {header(null)}
        <LoadError error={accounts.error} onRetry={() => void accounts.refetch()} />
      </>
    );
  }
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
  const unapproved = account
    ? account.unapprovedCount
    : accounts.data.accounts.reduce((n, a) => n + a.unapprovedCount, 0);
  const reviewing = filters.unapproved === true;
  const toApprove = transactions.filter((t) => !t.approved);
  let list;
  if (register.isPending) list = <Loading />;
  else if (register.isError) list = <LoadError error={register.error} onRetry={() => void register.refetch()} />;
  else if (transactions.length === 0) {
    list = (
      <p className="px-4 py-12 text-center text-muted">
        {reviewing ? 'Every transaction is approved.' : filtered ? 'No transactions match.' : 'No transactions yet.'}
      </p>
    );
  }
  const actions = (
    <>
      <button
        type="button"
        aria-label="Search"
        aria-expanded={searching}
        className={ROUND_BUTTON}
        onClick={() => setSearching(!searching)}
      >
        <SearchIcon />
      </button>
      <button
        type="button"
        aria-pressed={selected !== null}
        className={cx(PILL_BUTTON, selected && 'text-brand')}
        onClick={() => setSelected(selected ? null : new Set())}
      >
        Select
      </button>
    </>
  );
  return (
    <div>
      {header(account, actions)}
      {account && (
        <RegisterHeader account={account} balance={register.data?.pages[0]?.balances?.balance ?? account.balance} />
      )}
      <SearchBar filters={filters} open={searching} onFiltersChange={onFiltersChange} />
      {reviewing ? (
        <ReviewBar
          count={toApprove.length}
          busy={approve.isPending}
          // A bulk command takes at most 500 transactions.
          onApproveAll={() => approve.mutate(toApprove.slice(0, 500).map((t) => t.id))}
          onDone={() => onFiltersChange({ ...filters, unapproved: undefined })}
        />
      ) : (
        unapproved > 0 && (
          <ReviewBanner count={unapproved} onReview={() => onFiltersChange({ ...filters, unapproved: true })} />
        )
      )}
      {approve.error && (
        <div className="mx-4 mb-3">
          <FormError message={bulkErrorMessage(approve.error, toApprove)} />
        </div>
      )}
      {list ?? (
        <RegisterList
          transactions={transactions}
          accounts={byId}
          showAccount={account === null}
          onOpen={setEditing}
          selection={selected && { ids: selected, toggle }}
          onApprove={reviewing ? (transaction) => approve.mutate([transaction.id]) : null}
          onTransfer={setMarking}
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
      <Sheet open={editing !== null} onClose={() => setEditing(null)} title="Edit transaction">
        {editing && <TransactionForm transaction={editing} onDone={() => setEditing(null)} />}
      </Sheet>
      <Sheet open={marking !== null} onClose={() => setMarking(null)} title="Transfer">
        {marking && (
          <MarkTransfer transaction={marking} accounts={accounts.data.accounts} onDone={() => setMarking(null)} />
        )}
      </Sheet>
    </div>
  );
}
