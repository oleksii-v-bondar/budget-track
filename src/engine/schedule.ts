import { addDays, addMonths, dateInMonth, diffDays, monthDiff, monthOf } from './dates';
import type { IsoDate } from './types';

export type Frequency =
  | 'once'
  | 'daily'
  | 'weekly'
  | 'every_other_week'
  | 'twice_a_month'
  | 'every_4_weeks'
  | 'monthly'
  | 'every_other_month'
  | 'every_3_months'
  | 'every_4_months'
  | 'twice_a_year'
  | 'yearly'
  | 'every_other_year';

const DAY_STEPS: Partial<Record<Frequency, number>> = {
  daily: 1,
  weekly: 7,
  every_other_week: 14,
  every_4_weeks: 28,
};

const MONTH_STEPS: Partial<Record<Frequency, number>> = {
  monthly: 1,
  every_other_month: 2,
  every_3_months: 3,
  every_4_months: 4,
  twice_a_year: 6,
  yearly: 12,
  every_other_year: 24,
};

const anchorDay = (anchor: IsoDate) => Number(anchor.slice(8, 10));

/** First occurrence strictly after `after` for a schedule anchored at `anchor`; null when there is none. */
export function nextOccurrence(freq: Frequency, anchor: IsoDate, after: IsoDate): IsoDate | null {
  if (after < anchor) return anchor;
  if (freq === 'once') return null;

  const dayStep = DAY_STEPS[freq];
  if (dayStep) return addDays(anchor, (Math.floor(diffDays(anchor, after) / dayStep) + 1) * dayStep);

  const day = anchorDay(anchor);
  const monthStep = MONTH_STEPS[freq];
  if (monthStep) {
    const anchorMonth = monthOf(anchor);
    let k = Math.max(0, Math.floor(monthDiff(anchorMonth, monthOf(after)) / monthStep));
    let candidate = dateInMonth(addMonths(anchorMonth, k * monthStep), day);
    while (candidate <= after) {
      k += 1;
      candidate = dateInMonth(addMonths(anchorMonth, k * monthStep), day);
    }
    return candidate;
  }

  // twice_a_month: the anchor day plus the day 15 days away within the month, both clamped to month end.
  const days = day <= 15 ? [day, day + 15] : [day - 15, day];
  for (let month = monthOf(after); ; month = addMonths(month, 1)) {
    for (const d of days) {
      const candidate = dateInMonth(month, d);
      if (candidate > after) return candidate;
    }
  }
}

/** All occurrences from `nextDate` up to and including `today`, plus the schedule's new next date. */
export function dueOccurrences(
  freq: Frequency,
  anchor: IsoDate,
  nextDate: IsoDate,
  today: IsoDate,
  limit = 1000,
): { dates: IsoDate[]; nextDate: IsoDate | null } {
  const dates: IsoDate[] = [];
  let next: IsoDate | null = nextDate;
  while (next !== null && next <= today && dates.length < limit) {
    dates.push(next);
    next = nextOccurrence(freq, anchor, next);
  }
  return { dates, nextDate: next };
}
