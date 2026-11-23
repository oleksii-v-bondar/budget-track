import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { AccountDto } from '../../shared/api/accounts';
import { formatMoney } from '../lib/format';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { ChevronRightIcon, PlusIcon } from '../ui/icons';
import { LoadError, Loading } from '../ui/load-state';
import { Sheet } from '../ui/sheet';
import { ACCOUNT_TYPE_LABELS, groupAccounts, isForeign } from './account-groups';
import { accountsQuery } from './accounts-api';
import { AddAccountForm } from './add-account';

const amountClass = (minor: number) => cx('tabular-nums whitespace-nowrap', minor < 0 && 'text-red-600');

/** One account: its native balance, and for a foreign account "≈ X zł" at the latest NBP rate (spec §9). */
function AccountRow({ account }: { account: AccountDto }) {
  const working = account.balance.working;
  return (
    <Link
      to="/accounts/$accountId"
      params={{ accountId: account.id }}
      className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-gray-50"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{account.name}</span>
        <span className="block text-sm text-gray-500">{ACCOUNT_TYPE_LABELS[account.type]}</span>
      </span>
      <span className="flex flex-col items-end">
        <span className={amountClass(working)}>{formatMoney(working, account.currency)}</span>
        {isForeign(account) && account.balanceAtLatestRate !== null && (
          <span className="text-sm whitespace-nowrap text-gray-500">≈ {formatMoney(account.balanceAtLatestRate)}</span>
        )}
      </span>
      <ChevronRightIcon className="shrink-0 text-gray-400" />
    </Link>
  );
}

function AccountList({ accounts, label }: { accounts: AccountDto[]; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-gray-200 border-y border-gray-200 bg-white">
      {accounts.map((account) => (
        <li key={account.id}>
          <AccountRow account={account} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Spec §11 Accounts: the open accounts in Cash, Credit and Tracking, each group with its total in PLN (the
 * booked base balances the budget counts), and the closed accounts in a section that starts collapsed.
 */
export function AccountsScreen() {
  const query = useQuery(accountsQuery);
  const [showClosed, setShowClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  if (query.isPending) return <Loading />;
  if (query.isError) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;

  const { accounts } = query.data;
  const { groups, closed } = groupAccounts(accounts);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  return (
    <div className="flex flex-col gap-5 py-4">
      {accounts.length === 0 ? (
        <p className="px-4 py-8 text-center text-gray-600">Add your first account to start budgeting.</p>
      ) : (
        <Link
          to="/transactions"
          className="mx-4 flex min-h-14 items-center justify-between rounded-xl bg-white px-4 shadow-sm ring-1 ring-gray-200"
        >
          <span className="font-semibold">All accounts</span>
          <span className="flex items-center gap-2">
            <span className={amountClass(total)}>{formatMoney(total)}</span>
            <ChevronRightIcon className="text-gray-400" />
          </span>
        </Link>
      )}

      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`group-${group.key}`}>
          <h2 id={`group-${group.key}`} className="flex justify-between px-4 pb-1 text-xs font-semibold text-gray-500">
            <span className="tracking-wide uppercase">{group.label}</span>
            <span className={amountClass(group.total)} data-testid={`total-${group.key}`}>
              {formatMoney(group.total)}
            </span>
          </h2>
          <AccountList accounts={group.accounts} label={`${group.label} accounts`} />
        </section>
      ))}

      {closed.length > 0 && (
        <section>
          <button
            type="button"
            aria-expanded={showClosed}
            onClick={() => setShowClosed((shown) => !shown)}
            className="flex min-h-11 w-full items-center gap-1 px-4 text-xs font-semibold tracking-wide text-gray-500 uppercase"
          >
            <ChevronRightIcon className={cx('size-4 transition-transform', showClosed && 'rotate-90')} />
            Closed accounts ({closed.length})
          </button>
          {showClosed && <AccountList accounts={closed} label="Closed accounts" />}
        </section>
      )}

      <div className="px-4">
        <Button variant="secondary" block onClick={() => setAdding(true)}>
          <PlusIcon className="size-5" />
          Add account
        </Button>
      </div>
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add account">
        <AddAccountForm
          onDone={(account) => {
            setAdding(false);
            void navigate({ to: '/accounts/$accountId', params: { accountId: account.id } });
          }}
        />
      </Sheet>
    </div>
  );
}
