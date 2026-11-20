import type { IsoDate, Month } from './types';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_MS = 86_400_000;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function parseMonth(month: Month): { year: number; month: number } {
  const match = MONTH_RE.exec(month);
  const year = Number(match?.[1]);
  const m = Number(match?.[2]);
  if (!match || m < 1 || m > 12) throw new Error(`Invalid month: "${month}"`);
  return { year, month: m };
}

function parseDate(date: IsoDate): { year: number; month: number; day: number } {
  const match = DATE_RE.exec(date);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (!match || month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`Invalid date: "${date}"`);
  return { year, month, day };
}

function toUtcMs(date: IsoDate): number {
  const { year, month, day } = parseDate(date);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(ms: number): IsoDate {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function monthOf(date: IsoDate): Month {
  parseDate(date);
  return date.slice(0, 7);
}

export function addMonths(month: Month, n: number): Month {
  const { year, month: m } = parseMonth(month);
  const index = year * 12 + (m - 1) + n;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

/** Number of months from `from` to `to` (negative when `to` is earlier). */
export function monthDiff(from: Month, to: Month): number {
  const a = parseMonth(from);
  const b = parseMonth(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

/** Inclusive list of months from `from` to `to`; empty when `to` < `from`. */
export function monthRange(from: Month, to: Month): Month[] {
  const count = monthDiff(from, to) + 1;
  return Array.from({ length: Math.max(0, count) }, (_, i) => addMonths(from, i));
}

export function daysInMonth(month: Month): number {
  const { year, month: m } = parseMonth(month);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

/** The given day of `month`, clamped to the month's last day. */
export function dateInMonth(month: Month, day: number): IsoDate {
  return `${month}-${pad(Math.min(day, daysInMonth(month)))}`;
}

export function addDays(date: IsoDate, n: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + n * DAY_MS);
}

/** Number of days from `from` to `to` (negative when `to` is earlier). */
export function diffDays(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** Day of week, 0 = Sunday … 6 = Saturday. */
export function weekday(date: IsoDate): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

/** How many times weekday `wd` (0 = Sunday) occurs in `month`. */
export function countWeekdayInMonth(month: Month, wd: number): number {
  const first = weekday(dateInMonth(month, 1));
  const days = daysInMonth(month);
  const offset = (wd - first + 7) % 7;
  return offset >= days ? 0 : Math.floor((days - 1 - offset) / 7) + 1;
}
