/**
 * Display formats (spec §1): Polish number formatting (`1 234,56 zł`), dates as dd.MM.yyyy and English month names.
 * Amounts are integer minor units; every currency in use has two decimals (spec §2).
 */

/** No-break space: groups digits and keeps the currency on the same line as the amount. */
export const NBSP = '\u00a0';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "1 234,56" for 123456 minor units; negatives get a leading "-". Exact for every safe integer. */
export function formatAmount(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error(`Not an amount in minor units: ${minor}`);
  const abs = Math.abs(minor);
  const cents = abs % 100;
  const whole = String((abs - cents) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${minor < 0 ? '-' : ''}${whole},${String(cents).padStart(2, '0')}`;
}

/** "1 234,56 zł" for PLN, "1 234,56 EUR" for any other currency. */
export function formatMoney(minor: number, currency = 'PLN'): string {
  return `${formatAmount(minor)}${NBSP}${currency === 'PLN' ? 'zł' : currency}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "20.11.2026" for the ISO date "2026-11-20". */
export function formatDate(isoDate: string): string {
  const match = ISO_DATE.exec(isoDate);
  if (!match) throw new Error(`Not an ISO date: ${isoDate}`);
  return `${match[3]}.${match[2]}.${match[1]}`;
}

/** The ISO date for "20.11.2026" (one-digit day and month allowed), or null if it isn't a real calendar date. */
export function parseDate(text: string): string | null {
  const match = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/.exec(text);
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthParts(month: string): { year: string; name: (typeof MONTH_NAMES)[number] } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTH_NAMES[Number(match[2]) - 1] : undefined;
  if (!match || !name) throw new Error(`Not a month (YYYY-MM): ${month}`);
  return { year: match[1]!, name };
}

/** "November 2026" for "2026-11". */
export function formatMonth(month: string): string {
  const { year, name } = monthParts(month);
  return `${name} ${year}`;
}

/** "Nov 2026" for "2026-11". */
export function formatMonthShort(month: string): string {
  const { year, name } = monthParts(month);
  return `${name.slice(0, 3)} ${year}`;
}
