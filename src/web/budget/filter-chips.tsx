import { cx } from '../ui/cx';
import { BUDGET_FILTERS, type BudgetFilter } from './filters';

interface FilterChipsProps {
  value: BudgetFilter;
  counts: Record<BudgetFilter, number>;
  onChange: (filter: BudgetFilter) => void;
}

/** Spec §11: All / Underfunded / Overfunded / Money available / Snoozed, with how many categories each shows. */
export function FilterChips({ value, counts, onChange }: FilterChipsProps) {
  return (
    <div role="group" aria-label="Show" className="flex gap-2 overflow-x-auto px-4 pb-1">
      {BUDGET_FILTERS.map((filter) => {
        const pressed = filter.value === value;
        return (
          <button
            key={filter.value}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(filter.value)}
            className={cx(
              'flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-semibold whitespace-nowrap',
              pressed ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700',
            )}
          >
            {filter.label}
            {filter.value !== 'all' && (
              <span className={cx('tabular-nums', pressed ? 'text-gray-300' : 'text-gray-500')}>{counts[filter.value]}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
