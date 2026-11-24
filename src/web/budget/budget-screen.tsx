import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { BudgetMonthDto } from '../../shared/api/budget';
import { api, ApiError, unwrap } from '../lib/api';
import { errorMessage } from '../lib/commands';
import { formatMoney, formatMonth, formatMonthShort } from '../lib/format';
import { PILL_BUTTON, ScreenHeader } from '../shell/screen-header';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, EditIcon, FilterIcon, NoteIcon } from '../ui/icons';
import { Sheet } from '../ui/sheet';
import { budgetMonthQuery } from './budget-api';
import { CategoryList } from './category-list';
import { CategorySheetContent } from './category-sheet';
import { BudgetEditor } from './edit-mode';
import { FilterMenu } from './filter-menu';
import { BUDGET_FILTERS, type BudgetFilter, filterCounts } from './filters';
import { MonthPicker } from './month-picker';
import { NoteForm } from './note-form';
import { RtaSheetContent } from './rta-sheet';
import { findCategory, type RtaTone, rtaTone } from './view-model';

const BANNER_TONES: Record<RtaTone, string> = {
  green: 'bg-lime text-page',
  red: 'bg-red-500 text-white',
  grey: 'bg-zero text-white',
};

/** Spec §11: Ready to Assign, lime above 0, red below, grey at 0; tapping it opens the breakdown. */
function RtaBanner({ amount, onOpen }: { amount: number; onOpen: () => void }) {
  const tone = rtaTone(amount);
  return (
    <button
      type="button"
      data-testid="rta-banner"
      data-tone={tone}
      aria-haspopup="dialog"
      onClick={onOpen}
      className={cx(
        'mx-4 flex flex-wrap items-center justify-between gap-x-3 rounded-full px-5 py-4 text-left',
        BANNER_TONES[tone],
      )}
    >
      <span className="text-2xl leading-tight font-bold tabular-nums">{formatMoney(amount)}</span>
      <span className="flex items-center gap-1 text-base font-medium whitespace-nowrap">
        Ready to Assign
        <ChevronRightIcon className="size-5" />
      </span>
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
      className="mx-4 flex items-start gap-2 rounded-xl px-2 py-1.5 text-left text-sm text-muted hover:bg-white/5"
    >
      <NoteIcon className="size-5 shrink-0" />
      {note ? (
        <span className="line-clamp-2 whitespace-pre-line text-gray-200">{note}</span>
      ) : (
        <span>Add a note for {formatMonth(month)}</span>
      )}
    </button>
  );
}

function BudgetSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3 px-4 pt-2">
      <span className="sr-only">Loading the budget…</span>
      <div className="h-16 animate-pulse rounded-full bg-raised" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-xl bg-surface" />
      ))}
    </div>
  );
}

function LoadError({ error, onRetry, onThisMonth }: { error: unknown; onRetry: () => void; onThisMonth: () => void }) {
  const outOfRange = error instanceof ApiError && error.code === 'month_out_of_range';
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <p className="text-gray-200">{errorMessage(error)}</p>
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
function CategorySheet({
  view,
  categoryId,
  onClose,
}: {
  view: BudgetMonthDto;
  categoryId: string | null;
  onClose: () => void;
}) {
  const category = categoryId === null ? null : findCategory(view, categoryId);
  return (
    <Sheet open={category !== null} onClose={onClose} title={category?.name ?? ''}>
      {category && <CategorySheetContent view={view} category={category} onDone={onClose} />}
    </Sheet>
  );
}

const TOOL = 'flex size-11 items-center justify-center rounded-full hover:bg-white/10';

/** The top bar's left end: edit mode and the filters. */
function PlanTools({ filter, onEdit, onFilter }: { filter: BudgetFilter; onEdit: () => void; onFilter: () => void }) {
  return (
    <div className="flex items-center rounded-full bg-raised px-1 ring-1 ring-white/5">
      <button type="button" aria-label="Edit categories" className={TOOL} onClick={onEdit}>
        <EditIcon />
      </button>
      <button
        type="button"
        aria-label="Filter categories"
        aria-haspopup="dialog"
        className={cx(TOOL, 'relative')}
        onClick={onFilter}
      >
        <FilterIcon />
        {filter !== 'all' && <span className="absolute top-2 right-2 size-2 rounded-full bg-brand" />}
      </button>
    </div>
  );
}

export interface BudgetScreenProps {
  /** 'YYYY-MM' */
  month: string;
  filter: BudgetFilter;
  /** Without a month: this month. */
  onMonthChange: (month?: string) => void;
  onFilterChange: (filter: BudgetFilter) => void;
}

/**
 * The Plan (Budget) screen (spec §11) for `month`. Switching months keeps the last month on screen, dimmed, until the
 * new one arrives.
 */
export function BudgetScreen({ month, filter, onMonthChange, onFilterChange }: BudgetScreenProps) {
  const query = useQuery({ ...budgetMonthQuery(month), placeholderData: keepPreviousData });
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<'rta' | 'note' | 'month' | 'filter' | { categoryId: string } | null>(null);
  const close = () => setOpen(null);
  const view = query.data;
  const filterLabel = BUDGET_FILTERS.find((f) => f.value === filter)!.label;

  return (
    <div className="pb-4">
      <h1 className="sr-only">Plan</h1>
      <ScreenHeader
        left={
          editing ? (
            <button type="button" className={PILL_BUTTON} onClick={() => setEditing(false)}>
              Done
            </button>
          ) : (
            <PlanTools filter={filter} onEdit={() => setEditing(true)} onFilter={() => setOpen('filter')} />
          )
        }
        center={
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setOpen('month')}
            className="flex min-h-11 items-center gap-1 rounded-full px-2 text-xl font-bold whitespace-nowrap"
          >
            {formatMonthShort(month)}
            <ChevronDownIcon className="size-5" />
          </button>
        }
      />
      {view && editing ? (
        <div className="mt-3 flex flex-col gap-3">
          <h2 className="px-4 text-2xl font-bold">Edit categories</h2>
          <BudgetEditor view={view} />
        </div>
      ) : view ? (
        <div
          aria-busy={query.isPlaceholderData || undefined}
          className={cx('mt-3 flex flex-col gap-3', query.isPlaceholderData && 'opacity-60')}
        >
          <RtaBanner amount={view.rta.readyToAssign} onOpen={() => setOpen('rta')} />
          <MonthNote month={view.month} note={view.note} onOpen={() => setOpen('note')} />
          {filter !== 'all' && (
            <button
              type="button"
              aria-label={`Show all categories (now: ${filterLabel})`}
              onClick={() => onFilterChange('all')}
              className="mx-4 flex min-h-9 items-center gap-2 self-start rounded-full bg-brand-light px-4 text-sm font-semibold text-indigo-200"
            >
              {filterLabel}
              <CloseIcon className="size-4" />
            </button>
          )}
          <CategoryList view={view} filter={filter} onOpen={(categoryId) => setOpen({ categoryId })} />
          <Sheet open={open === 'rta'} onClose={close} title="Ready to Assign">
            <RtaSheetContent view={view} onDone={close} />
          </Sheet>
          <CategorySheet
            view={view}
            categoryId={typeof open === 'object' && open ? open.categoryId : null}
            onClose={close}
          />
          <Sheet open={open === 'note'} onClose={close} title={`Note for ${formatMonth(view.month)}`}>
            <NoteForm
              label="Note"
              initial={view.note}
              send={(note) =>
                unwrap(api.api.budget[':month'].note.$put({ param: { month: view.month }, json: { note } }))
              }
              onDone={close}
            />
          </Sheet>
        </div>
      ) : query.isError ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} onThisMonth={() => onMonthChange()} />
      ) : (
        <BudgetSkeleton />
      )}
      {view && (
        <>
          <Sheet open={open === 'month'} onClose={close} title="Choose a month">
            <MonthPicker
              month={month}
              bounds={view}
              onPick={(picked) => {
                close();
                onMonthChange(picked);
              }}
            />
          </Sheet>
          <Sheet open={open === 'filter'} onClose={close} title="Show">
            <FilterMenu
              value={filter}
              counts={filterCounts(view)}
              onChange={(picked) => {
                close();
                onFilterChange(picked);
              }}
            />
          </Sheet>
        </>
      )}
    </div>
  );
}
