import { addMonths } from '../../engine/dates';
import { formatMonth } from '../lib/format';
import { Button } from '../ui/button';
import { ChevronLeftIcon, ChevronRightIcon } from '../ui/icons';

/** The month view's range: `firstMonth` (budget start, or earlier money) .. `lastMonth` (this month + 24). */
export interface MonthBounds {
  firstMonth: string;
  currentMonth: string;
  lastMonth: string;
}

interface MonthSwitcherProps {
  month: string;
  /** Unknown until the first month view arrives: both arrows stay disabled. */
  bounds: MonthBounds | undefined;
  onChange: (month: string) => void;
}

/** Spec §11: back to the budget's first month, forward up to 24 months, and a way back to this month. */
export function MonthSwitcher({ month, bounds, onChange }: MonthSwitcherProps) {
  return (
    <nav aria-label="Month" className="flex items-center gap-1 px-2 py-1">
      <Button
        variant="ghost"
        aria-label="Previous month"
        disabled={!bounds || month <= bounds.firstMonth}
        onClick={() => onChange(addMonths(month, -1))}
        className="px-2"
      >
        <ChevronLeftIcon />
      </Button>
      <div className="flex min-h-11 flex-1 flex-col items-center justify-center">
        <h2 className="text-lg leading-tight font-semibold">{formatMonth(month)}</h2>
        {bounds && month !== bounds.currentMonth && (
          <button type="button" className="text-sm font-medium text-brand" onClick={() => onChange(bounds.currentMonth)}>
            Go to this month
          </button>
        )}
      </div>
      <Button
        variant="ghost"
        aria-label="Next month"
        disabled={!bounds || month >= bounds.lastMonth}
        onClick={() => onChange(addMonths(month, 1))}
        className="px-2"
      >
        <ChevronRightIcon />
      </Button>
    </nav>
  );
}
