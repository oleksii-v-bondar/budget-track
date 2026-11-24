import { Link, type LinkProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { groupAccounts } from '../accounts/account-groups';
import { rtaTone } from '../budget/view-model';
import { formatMoney } from '../lib/format';
import { monthTotals } from '../reflect/reflect-model';
import { ScreenHeader } from '../shell/screen-header';
import { cx } from '../ui/cx';
import { ChevronRightIcon } from '../ui/icons';
import { LoadError, Loading } from '../ui/load-state';
import { useAttention } from './attention';

const CARD = 'block rounded-3xl bg-surface p-5 hover:bg-white/5';
const CARD_TITLE = 'flex items-center justify-between text-lg font-semibold';

const RTA_TONES = { green: 'bg-lime text-page', red: 'bg-red-500 text-white', grey: 'bg-zero text-white' };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One "Needs attention" line: a count in its colour, what it counts, and where to deal with it. */
function AttentionRow({ count, tone, label, ...link }: { count: number; tone: string; label: string } & LinkProps) {
  return (
    <li>
      <Link {...link} className="flex min-h-12 items-center gap-3 py-1">
        <span
          aria-hidden="true"
          className={cx(
            'flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-sm font-bold tabular-nums',
            count > 0 ? tone : 'bg-zero text-muted',
          )}
        >
          {count}
        </span>
        <span className={cx('flex-1 text-[17px]', count === 0 && 'text-muted')}>{label}</span>
        <ChevronRightIcon className="text-muted" />
      </Link>
    </li>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between py-1 text-[17px]">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}

/** Home: Ready to Assign, what needs attention, this month's spending and income, and the accounts. */
export function HomeScreen() {
  const { accounts, budget, review, overspent, underfunded } = useAttention();
  const header = <ScreenHeader title="Home" />;
  if (budget.isError || accounts.isError) {
    const retry = () => void Promise.all([budget.refetch(), accounts.refetch()]);
    return (
      <>
        {header}
        <LoadError error={budget.error ?? accounts.error} onRetry={retry} />
      </>
    );
  }
  if (!budget.data || !accounts.data) {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }

  const view = budget.data;
  const rta = view.rta.readyToAssign;
  const { income, spending } = monthTotals(view);
  const { groups } = groupAccounts(accounts.data.accounts);
  const netWorth = groups.reduce((sum, group) => sum + group.total, 0);
  return (
    <>
      {header}
      <div className="flex flex-col gap-4 px-4">
        <Link to="/budget" data-testid="home-rta" className={cx('block rounded-3xl p-5', RTA_TONES[rtaTone(rta)])}>
          <span className="flex items-center justify-between text-lg font-medium">
            Ready to Assign
            <ChevronRightIcon />
          </span>
          <span className="mt-1 block text-[34px] leading-tight font-bold tabular-nums">{formatMoney(rta)}</span>
        </Link>

        <section aria-labelledby="attention-title" className="rounded-3xl bg-surface p-5">
          <h2 id="attention-title" className="text-lg font-semibold">
            Needs attention
          </h2>
          <ul className="mt-2 flex flex-col">
            <AttentionRow
              count={review}
              tone="bg-brand text-white"
              label={plural(review, 'transaction to review', 'transactions to review')}
              to="/transactions"
              search={{ unapproved: true }}
            />
            <AttentionRow
              count={overspent}
              tone="bg-red-500 text-white"
              label={plural(overspent, 'overspent category', 'overspent categories')}
              to="/budget"
              search={{ filter: 'overspent' }}
            />
            <AttentionRow
              count={underfunded}
              tone="bg-yellow-400 text-page"
              label={plural(underfunded, 'underfunded category', 'underfunded categories')}
              to="/budget"
              search={{ filter: 'underfunded' }}
            />
          </ul>
        </section>

        <Link to="/reflect" className={CARD}>
          <span className={CARD_TITLE}>
            This month
            <ChevronRightIcon className="text-muted" />
          </span>
          <dl className="mt-2">
            <Line label="Spent so far">{formatMoney(spending)}</Line>
            <Line label="Income">{formatMoney(income)}</Line>
          </dl>
          {income > 0 && (
            <div aria-hidden="true" className="mt-3 h-2 overflow-hidden rounded-full bg-zero">
              <div
                className={cx('h-full rounded-full', spending > income ? 'bg-red-500' : 'bg-brand')}
                style={{ width: `${Math.min(100, (spending / income) * 100)}%` }}
              />
            </div>
          )}
        </Link>

        <Link to="/accounts" className={CARD}>
          <span className={CARD_TITLE}>
            Accounts
            <ChevronRightIcon className="text-muted" />
          </span>
          <dl className="mt-2">
            <Line label="Net worth">
              <span className={cx('font-semibold', netWorth < 0 && 'text-red-400')}>{formatMoney(netWorth)}</span>
            </Line>
            {groups.map((group) => (
              <Line key={group.key} label={group.label}>
                <span className={cx(group.total < 0 && 'text-red-400')}>{formatMoney(group.total)}</span>
              </Line>
            ))}
          </dl>
        </Link>
      </div>
    </>
  );
}
