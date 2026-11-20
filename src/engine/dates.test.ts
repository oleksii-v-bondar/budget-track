import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  countWeekdayInMonth,
  dateInMonth,
  daysInMonth,
  diffDays,
  monthDiff,
  monthOf,
  monthRange,
  weekday,
} from './dates';

describe('months', () => {
  it('extracts the month of a date', () => {
    expect(monthOf('2026-11-19')).toBe('2026-11');
  });

  it('adds months across year boundaries', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-05', 0)).toBe('2026-05');
  });

  it('computes signed month differences', () => {
    expect(monthDiff('2026-01', '2026-12')).toBe(11);
    expect(monthDiff('2026-03', '2025-12')).toBe(-3);
  });

  it('builds inclusive month ranges', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthRange('2026-02', '2026-01')).toEqual([]);
  });

  it('knows month lengths including leap years', () => {
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-12')).toBe(31);
  });

  it('clamps days past month end', () => {
    expect(dateInMonth('2026-02', 31)).toBe('2026-02-28');
    expect(dateInMonth('2026-03', 5)).toBe('2026-03-05');
  });

  it('rejects malformed values', () => {
    expect(() => monthOf('2026-1-01')).toThrow('Invalid date');
    expect(() => addMonths('2026-13', 1)).toThrow('Invalid month');
  });
});

describe('days', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('computes signed day differences', () => {
    expect(diffDays('2026-01-01', '2026-03-01')).toBe(59);
    expect(diffDays('2026-01-10', '2026-01-03')).toBe(-7);
  });

  it('returns weekday with 0 = Sunday', () => {
    expect(weekday('2026-11-19')).toBe(4); // Thursday
    expect(weekday('2026-11-22')).toBe(0); // Sunday
  });

  it('counts weekdays in a month', () => {
    expect(countWeekdayInMonth('2026-06', 1)).toBe(5); // June 2026 starts on a Monday
    expect(countWeekdayInMonth('2026-06', 0)).toBe(4);
    expect(countWeekdayInMonth('2026-02', 3)).toBe(4);
  });
});
