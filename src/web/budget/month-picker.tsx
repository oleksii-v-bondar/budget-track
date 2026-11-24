import { useState } from 'react';
import { formatMonth } from '../lib/format';
import { Button } from '../ui/button';
import { cx } from '../ui/cx';
import { ChevronLeftIcon, ChevronRightIcon } from '../ui/icons';

/** The month view's range: `firstMonth` (budget start, or earlier money) .. `lastMonth` (this month + 24). */
export interface MonthBounds {
  firstMonth: string;
  currentMonth: string;
  lastMonth: string;
}

const SHORT_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface MonthPickerProps {
  month: string;
  bounds: MonthBounds;
  onPick: (month: string) => void;
}

/** Spec §11: any month from the budget's first month to 24 months ahead, a year at a time, and this month. */
export function MonthPicker({ month, bounds, onPick }: MonthPickerProps) {
  const [year, setYear] = useState(Number(month.slice(0, 4)));
  const months = SHORT_NAMES.map((name, i) => ({ name, value: `${year}-${String(i + 1).padStart(2, '0')}` }));
  const inRange = (value: string) => value >= bounds.firstMonth && value <= bounds.lastMonth;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          aria-label="Previous year"
          disabled={`${year}-01` <= bounds.firstMonth}
          onClick={() => setYear(year - 1)}
          className="px-2"
        >
          <ChevronLeftIcon />
        </Button>
        <h3 className="text-lg font-bold tabular-nums">{year}</h3>
        <Button
          variant="ghost"
          aria-label="Next year"
          disabled={`${year}-12` >= bounds.lastMonth}
          onClick={() => setYear(year + 1)}
          className="px-2"
        >
          <ChevronRightIcon />
        </Button>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {months.map(({ name, value }) => (
          <button
            key={value}
            type="button"
            aria-label={formatMonth(value)}
            aria-pressed={value === month}
            disabled={!inRange(value)}
            onClick={() => onPick(value)}
            className={cx(
              'min-h-12 rounded-xl text-base font-semibold disabled:text-zero',
              value === month ? 'bg-brand text-white' : 'bg-raised text-white hover:bg-white/10',
              value === bounds.currentMonth && value !== month && 'ring-1 ring-brand',
            )}
          >
            {name}
          </button>
        ))}
      </div>
      {month !== bounds.currentMonth && (
        <Button variant="secondary" onClick={() => onPick(bounds.currentMonth)}>
          Go to this month
        </Button>
      )}
    </div>
  );
}
