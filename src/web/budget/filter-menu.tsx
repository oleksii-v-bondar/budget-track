import { cx } from '../ui/cx';
import { BUDGET_FILTERS, type BudgetFilter } from './filters';

interface FilterMenuProps {
  value: BudgetFilter;
  counts: Record<BudgetFilter, number>;
  onChange: (filter: BudgetFilter) => void;
}

/** The Plan's filters (in a sheet): All, Overspent, Underfunded, ..., with how many categories each shows. */
export function FilterMenu({ value, counts, onChange }: FilterMenuProps) {
  return (
    <div role="group" aria-label="Show" className="-mx-4 -mt-4 flex flex-col divide-y divide-line">
      {BUDGET_FILTERS.map((filter) => {
        const pressed = filter.value === value;
        return (
          <button
            key={filter.value}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(filter.value)}
            className={cx(
              'flex min-h-13 items-center justify-between gap-3 px-4 text-left text-base hover:bg-white/5',
              pressed ? 'font-semibold text-brand' : 'text-white',
            )}
          >
            {filter.label}
            {filter.value !== 'all' && <span className="text-muted tabular-nums">{counts[filter.value]}</span>}
          </button>
        );
      })}
    </div>
  );
}
