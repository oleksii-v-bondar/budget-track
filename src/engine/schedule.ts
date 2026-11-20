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

const DAY_STEPS = {
  daily: 1,
  weekly: 7,
  every_other_week: 14,
  every_4_weeks: 28,
} as const satisfies Partial<Record<Frequency, number>>;

const MONTH_STEPS = {
  monthly: 1,
  every_other_month: 2,
  every_3_months: 3,
  every_4_months: 4,
  twice_a_year: 6,
  yearly: 12,
  every_other_year: 24,
} as const satisfies Partial<Record<Frequency, number>>;

const anchorDay = (anchor: IsoDate) => Number(anchor.slice(8, 10));

function nextByDays(anchor: IsoDate, after: IsoDate, step: number): IsoDate {
  return addDays(anchor, (Math.floor(diffDays(anchor, after) / step) + 1) * step);
}

function nextByMonths(anchor: IsoDate, after: IsoDate, step: number): IsoDate {
  const day = anchorDay(anchor);
  const anchorMonth = monthOf(anchor);
  let k = Math.max(0, Math.floor(monthDiff(anchorMonth, monthOf(after)) / step));
  let candidate = dateInMonth(addMonths(anchorMonth, k * step), day);
  while (candidate <= after) {
    k += 1;
    candidate = dateInMonth(addMonths(anchorMonth, k * step), day);
  }
  return candidate;
}

/** The anchor day plus the day 15 days away within the month, both clamped to month end. */
function nextTwiceAMonth(anchor: IsoDate, after: IsoDate): IsoDate {
  const day = anchorDay(anchor);
  const days = day <= 15 ? [day, day + 15] : [day - 15, day];
  for (let month = monthOf(after); ; month = addMonths(month, 1)) {
    for (const d of days) {
      const candidate = dateInMonth(month, d);
      if (candidate > after) return candidate;
    }
  }
}

/** Exhaustiveness guard; also rejects bad values that reach the engine at runtime (e.g. from the database). */
function unknownFrequency(freq: never): never {
  throw new Error(`Unknown frequency: ${String(freq)}`);
}

/** First occurrence strictly after `after` for a schedule anchored at `anchor`; null when there is none. */
export function nextOccurrence(freq: Frequency, anchor: IsoDate, after: IsoDate): IsoDate | null {
  const anchorAhead = after < anchor;
  switch (freq) {
    case 'once':
      return anchorAhead ? anchor : null;
    case 'daily':
    case 'weekly':
    case 'every_other_week':
    case 'every_4_weeks':
      return anchorAhead ? anchor : nextByDays(anchor, after, DAY_STEPS[freq]);
    case 'monthly':
    case 'every_other_month':
    case 'every_3_months':
    case 'every_4_months':
    case 'twice_a_year':
    case 'yearly':
    case 'every_other_year':
      return anchorAhead ? anchor : nextByMonths(anchor, after, MONTH_STEPS[freq]);
    case 'twice_a_month':
      return anchorAhead ? anchor : nextTwiceAMonth(anchor, after);
    default:
      return unknownFrequency(freq);
  }
}

/**
 * Occurrences from `nextDate` up to and including `today`, plus the schedule's new next date.
 * At most `limit` dates are returned. When the limit is hit the list is partial and the returned `nextDate` may still
 * be ≤ `today`, so callers loop until it is after `today` (or null).
 */
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
