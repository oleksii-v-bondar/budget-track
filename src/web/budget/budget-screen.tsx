import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { BudgetMonthDto } from '../../shared/api/budget';
import { api, ApiError, unwrap } from '../lib/api';
import { errorMessage } from '../lib/commands';
import { formatMoney, formatMonth } from '../lib/format';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { NoteIcon } from '../ui/icons';
import { Sheet } from '../ui/sheet';
import { budgetMonthQuery } from './budget-api';
import { CategoryList } from './category-list';
import { CategorySheetContent } from './category-sheet';
import { BudgetEditor } from './edit-mode';
import { FilterChips } from './filter-chips';
import { type BudgetFilter, filterCounts } from './filters';
import { MonthSwitcher } from './month-switcher';
import { NoteForm } from './note-form';
import { RtaSheetContent } from './rta-sheet';
import { findCategory, type RtaTone, rtaTone } from './view-model';

const BANNER_TONES: Record<RtaTone, string> = {
  green: 'bg-brand text-white',
  red: 'bg-red-600 text-white',
  grey: 'bg-gray-200 text-gray-800',
};

/** Spec §11: Ready to Assign, green above 0, red below, grey at 0; tapping it opens the breakdown. */
function RtaBanner({ amount, onOpen }: { amount: number; onOpen: () => void }) {
  const tone = rtaTone(amount);
  return (
    <button
      type="button"
      data-testid="rta-banner"
      data-tone={tone}
      aria-haspopup="dialog"
      onClick={onOpen}
      className={cx('mx-4 rounded-2xl px-4 py-3 text-center', BANNER_TONES[tone])}
    >
      <span className="block text-2xl font-bold tabular-nums">{formatMoney(amount)}</span>
      <span className="block text-sm font-medium">Ready to Assign</span>
    </button>
  );
}

/** The month note (spec §11): its text, or an invitation to write one. */
function MonthNote({ month, note, onOpen }: { month: string; note: string | null; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onOpen}
      className="mx-4 flex items-start gap-2 rounded-xl px-2 py-1.5 text-left text-sm text-gray-600 hover:bg-gray-50"
    >
      <NoteIcon className="size-5 shrink-0 text-gray-400" />
      {note ? (
        <span className="line-clamp-2 whitespace-pre-line">{note}</span>
      ) : (
        <span className="text-gray-500">Add a note for {formatMonth(month)}</span>
      )}
    </button>
  );
}

function BudgetSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3 px-4 pt-2">
      <span className="sr-only">Loading the budget…</span>
      <div className="h-16 animate-pulse rounded-2xl bg-gray-200" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-10 animate-pulse rounded-xl bg-gray-100" />
      ))}
    </div>
  );
}

function LoadError({ error, onRetry, onThisMonth }: { error: unknown; onRetry: () => void; onThisMonth: () => void }) {
  const outOfRange = error instanceof ApiError && error.code === 'month_out_of_range';
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <p className="text-gray-700">{errorMessage(error)}</p>
      {outOfRange ? (
        <Button onClick={onThisMonth}>Go to this month</Button>
      ) : (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** The sheet of the category with `categoryId`; it closes by itself if the category goes away (deleted, undone). */
function CategorySheet({ view, categoryId, onClose }: { view: BudgetMonthDto; categoryId: string | null; onClose: () => void }) {
  const category = categoryId === null ? null : findCategory(view, categoryId);
  return (
    <Sheet open={category !== null} onClose={onClose} title={category?.name ?? ''}>
      {category && <CategorySheetContent view={view} category={category} onDone={onClose} />}
    </Sheet>
  );
}

/**
 * The Budget screen (spec §11) for `month` ('YYYY-MM'). Switching months keeps the last month on screen, dimmed,
 * until the new one arrives.
 */
export function BudgetScreen({ month }: { month: string }) {
  const navigate = useNavigate();
  const query = useQuery({ ...budgetMonthQuery(month), placeholderData: keepPreviousData });
  const [filter, setFilter] = useState<BudgetFilter>('all');
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<'rta' | 'note' | { categoryId: string } | null>(null);
  const close = () => setOpen(null);
  const goTo = (target?: string) => void navigate({ to: '/budget', search: target ? { month: target } : {} });
  const view = query.data;

  return (
    <div className="pb-4">
      <MonthSwitcher month={month} bounds={view} onChange={goTo} />
      {view && editing ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between px-4">
            <h3 className="font-semibold">Edit categories</h3>
            <Button variant="ghost" onClick={() => setEditing(false)} className="px-3">
              Done
            </Button>
          </div>
          <BudgetEditor view={view} />
        </div>
      ) : view ? (
        <div aria-busy={query.isPlaceholderData || undefined} className={cx('flex flex-col gap-3', query.isPlaceholderData && 'opacity-60')}>
          <RtaBanner amount={view.rta.readyToAssign} onOpen={() => setOpen('rta')} />
          <MonthNote month={view.month} note={view.note} onOpen={() => setOpen('note')} />
          <div className="flex items-center gap-1 pr-2">
            <div className="min-w-0 flex-1">
              <FilterChips value={filter} counts={filterCounts(view)} onChange={setFilter} />
            </div>
            <Button variant="ghost" onClick={() => setEditing(true)} className="shrink-0 px-3">
              Edit
            </Button>
          </div>
          <CategoryList view={view} filter={filter} onOpen={(categoryId) => setOpen({ categoryId })} />
          <Sheet open={open === 'rta'} onClose={close} title="Ready to Assign">
            <RtaSheetContent view={view} onDone={close} />
          </Sheet>
          <CategorySheet view={view} categoryId={typeof open === 'object' && open ? open.categoryId : null} onClose={close} />
          <Sheet open={open === 'note'} onClose={close} title={`Note for ${formatMonth(view.month)}`}>
            <NoteForm
              label="Note"
              initial={view.note}
              send={(note) => unwrap(api.api.budget[':month'].note.$put({ param: { month: view.month }, json: { note } }))}
              onDone={close}
            />
          </Sheet>
        </div>
      ) : query.isError ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} onThisMonth={() => goTo()} />
      ) : (
        <BudgetSkeleton />
      )}
    </div>
  );
}
