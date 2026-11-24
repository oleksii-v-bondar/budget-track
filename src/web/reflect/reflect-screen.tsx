import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { addMonths } from '../../engine/dates';
import type { BudgetMonthDto } from '../../shared/api/budget';
import { budgetMonthQuery } from '../budget/budget-api';
import { formatMoney, formatMonth, thisMonth } from '../lib/format';
import { ScreenHeader } from '../shell/screen-header';
import { Button } from '../ui/button';
import { ChevronLeftIcon, ChevronRightIcon, PieIcon, ReflectIcon } from '../ui/icons';
import { LoadError, Loading } from '../ui/load-state';
import { chartMonths, incomeVsSpending, type MonthTotals, spendingBreakdown } from './reflect-model';

const CARD = 'mx-4 rounded-3xl bg-surface p-5';
const CARD_TITLE = 'flex items-center gap-2 text-lg font-semibold text-brand';

/** The month's dates for Spending's From and To filters. */
function monthRange(month: string): { from: string; to: string } {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

interface BreakdownCardProps {
  view: BudgetMonthDto;
  canGoBack: boolean;
  canGoForward: boolean;
  onMonthChange: (month: string) => void;
}

/** Spending Breakdown: the month's total, a bar in the categories' colours and the top five categories. */
function BreakdownCard({ view, canGoBack, canGoForward, onMonthChange }: BreakdownCardProps) {
  const { total, slices } = spendingBreakdown(view);
  return (
    <section aria-labelledby="breakdown-title" className={CARD}>
      <h2 id="breakdown-title">
        <Link to="/transactions" search={monthRange(view.month)} className={CARD_TITLE}>
          <PieIcon className="size-5" />
          Spending Breakdown
          <ChevronRightIcon className="ml-auto text-muted" />
        </Link>
      </h2>
      <div className="mt-3 flex items-center justify-between">
        <p className="text-lg text-muted">{formatMonth(view.month)}</p>
        <div className="-mr-2 flex">
          <Button
            variant="ghost"
            aria-label="Previous month"
            disabled={!canGoBack}
            className="px-2"
            onClick={() => onMonthChange(addMonths(view.month, -1))}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="ghost"
            aria-label="Next month"
            disabled={!canGoForward}
            className="px-2"
            onClick={() => onMonthChange(addMonths(view.month, 1))}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
      <p className="text-[40px] leading-tight font-bold tabular-nums" data-testid="spent-total">
        {formatMoney(total)}
      </p>
      {total === 0 ? (
        <p className="mt-3 text-muted">No spending this month.</p>
      ) : (
        <>
          <div aria-hidden="true" className="mt-4 flex h-9 gap-0.5 overflow-hidden rounded-lg">
            {slices.map((slice) => (
              <div key={slice.id} style={{ width: `${(slice.spent / total) * 100}%`, backgroundColor: slice.color }} />
            ))}
          </div>
          <div className="mt-5 flex justify-between text-muted">
            <span>Top Categories</span>
            <span>Spent</span>
          </div>
          <ul aria-label="Top categories" className="mt-2 flex flex-col">
            {slices.map((slice) => (
              <li key={slice.id} className="flex items-center gap-3 py-2 text-[17px]">
                <span
                  aria-hidden="true"
                  className="h-4 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: slice.color }}
                />
                <span className="min-w-0 flex-1 truncate">{slice.name}</span>
                <span className="tabular-nums">{formatMoney(slice.spent)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const SHORT_MONTH = (month: string) => formatMonth(month).slice(0, 3);

/** Income vs. Spending: one sentence and a bar pair per month (income green, spending indigo). */
function IncomeVsSpendingCard({ months, summary }: { months: MonthTotals[]; summary: string | null }) {
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.spending]));
  const height = (amount: number) => `${Math.max(0, amount / max) * 100}%`;
  return (
    <section aria-labelledby="income-title" className={CARD}>
      <h2 id="income-title" className={CARD_TITLE}>
        <ReflectIcon className="size-5" />
        Income vs. Spending
      </h2>
      {summary && <p className="mt-3 text-xl leading-snug font-semibold">{summary}</p>}
      <div className="mt-5 flex h-40 items-end gap-2 border-b border-line">
        {months.map((m) => (
          <div
            key={m.month}
            role="img"
            aria-label={`${formatMonth(m.month)}: income ${formatMoney(m.income)}, spending ${formatMoney(m.spending)}`}
            className="flex h-full flex-1 items-end justify-center gap-1"
          >
            <div className="w-1/3 max-w-5 rounded-t bg-income" style={{ height: height(m.income) }} />
            <div className="w-1/3 max-w-5 rounded-t bg-brand" style={{ height: height(m.spending) }} />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="mt-2 flex gap-2 text-sm text-muted">
        {months.map((m) => (
          <span key={m.month} className="flex-1 text-center">
            {SHORT_MONTH(m.month)}
          </span>
        ))}
      </div>
      <div className="mt-4 flex gap-5 text-sm">
        <span className="flex items-center gap-2">
          <span className="size-3 rounded-full bg-income" />
          Income
        </span>
        <span className="flex items-center gap-2">
          <span className="size-3 rounded-full bg-brand" />
          Spending
        </span>
      </div>
    </section>
  );
}

/** Reflect: where a month's money went, and income against spending over the last six months. */
export function ReflectScreen() {
  const [current] = useState(thisMonth);
  const [month, setMonth] = useState(current);
  const anchor = useQuery(budgetMonthQuery(current));
  const view = useQuery({ ...budgetMonthQuery(month), placeholderData: keepPreviousData });
  const months = chartMonths(current);
  const known = anchor.data ? months.filter((m) => m >= anchor.data.firstMonth) : [];
  const history = useQueries({ queries: known.map((m) => budgetMonthQuery(m)) });
  const views = history.flatMap((q) => (q.data ? [q.data] : []));
  const chart = anchor.data && views.length === known.length ? incomeVsSpending(months, views) : null;

  let content;
  if (anchor.isError) content = <LoadError error={anchor.error} onRetry={() => void anchor.refetch()} />;
  else if (!anchor.data || !view.data) content = <Loading />;
  else {
    content = (
      <div className="flex flex-col gap-4">
        <BreakdownCard
          view={view.data}
          canGoBack={month > anchor.data.firstMonth}
          canGoForward={month < current}
          onMonthChange={setMonth}
        />
        {chart ? <IncomeVsSpendingCard months={chart.totals} summary={chart.summary} /> : <Loading />}
      </div>
    );
  }
  return (
    <>
      <ScreenHeader title="Reflect" />
      {content}
    </>
  );
}
