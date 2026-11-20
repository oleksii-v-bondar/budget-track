import { describe, expect, it } from 'vitest';
import { dueOccurrences, nextOccurrence } from './schedule';

describe('nextOccurrence: day-based frequencies', () => {
  it('steps by a fixed number of days from the anchor', () => {
    expect(nextOccurrence('daily', '2026-01-30', '2026-01-31')).toBe('2026-02-01');
    expect(nextOccurrence('weekly', '2026-01-05', '2026-01-05')).toBe('2026-01-12');
    expect(nextOccurrence('weekly', '2026-01-05', '2026-01-08')).toBe('2026-01-12');
    expect(nextOccurrence('every_other_week', '2026-01-05', '2026-01-05')).toBe('2026-01-19');
    expect(nextOccurrence('every_4_weeks', '2026-01-05', '2026-01-05')).toBe('2026-02-02');
  });

  it('returns the anchor while it is still ahead', () => {
    expect(nextOccurrence('weekly', '2026-03-01', '2026-01-01')).toBe('2026-03-01');
    expect(nextOccurrence('monthly', '2026-03-01', '2026-01-01')).toBe('2026-03-01');
  });
});

describe('nextOccurrence: month-based frequencies', () => {
  it('keeps the anchor day and clamps to month end', () => {
    expect(nextOccurrence('monthly', '2026-01-31', '2026-01-31')).toBe('2026-02-28');
    expect(nextOccurrence('monthly', '2026-01-31', '2026-02-28')).toBe('2026-03-31');
  });

  it('supports multi-month steps', () => {
    expect(nextOccurrence('every_other_month', '2026-01-15', '2026-01-15')).toBe('2026-03-15');
    expect(nextOccurrence('every_3_months', '2026-01-15', '2026-01-15')).toBe('2026-04-15');
    expect(nextOccurrence('every_4_months', '2026-01-15', '2026-02-01')).toBe('2026-05-15');
    expect(nextOccurrence('twice_a_year', '2026-01-15', '2026-01-15')).toBe('2026-07-15');
    expect(nextOccurrence('yearly', '2024-02-29', '2024-02-29')).toBe('2025-02-28');
    expect(nextOccurrence('yearly', '2024-02-29', '2027-03-01')).toBe('2028-02-29');
    expect(nextOccurrence('every_other_year', '2026-06-01', '2026-06-01')).toBe('2028-06-01');
  });

  it('twice a month: anchor day and 15 days later (or earlier when past the 15th)', () => {
    expect(nextOccurrence('twice_a_month', '2026-01-10', '2026-01-10')).toBe('2026-01-25');
    expect(nextOccurrence('twice_a_month', '2026-01-10', '2026-01-25')).toBe('2026-02-10');
    expect(nextOccurrence('twice_a_month', '2026-01-20', '2026-01-20')).toBe('2026-02-05');
    expect(nextOccurrence('twice_a_month', '2026-01-15', '2026-02-15')).toBe('2026-02-28');
  });

  it('once: only the anchor', () => {
    expect(nextOccurrence('once', '2026-01-10', '2026-01-09')).toBe('2026-01-10');
    expect(nextOccurrence('once', '2026-01-10', '2026-01-10')).toBeNull();
  });
});

describe('dueOccurrences', () => {
  it('collects every occurrence up to today and returns the next one', () => {
    expect(dueOccurrences('monthly', '2026-01-01', '2026-01-01', '2026-03-15')).toEqual({
      dates: ['2026-01-01', '2026-02-01', '2026-03-01'],
      nextDate: '2026-04-01',
    });
  });

  it('returns nothing when the next date is in the future', () => {
    expect(dueOccurrences('weekly', '2026-01-05', '2026-01-12', '2026-01-11')).toEqual({ dates: [], nextDate: '2026-01-12' });
  });

  it('ends a one-off schedule after it is entered', () => {
    expect(dueOccurrences('once', '2026-01-10', '2026-01-10', '2026-01-10')).toEqual({ dates: ['2026-01-10'], nextDate: null });
  });

  it('caps the number of occurrences', () => {
    expect(dueOccurrences('daily', '2020-01-01', '2020-01-01', '2026-01-01', 3).dates).toHaveLength(3);
  });

  it('is monotonic: every returned date is after the previous one', () => {
    const { dates } = dueOccurrences('twice_a_month', '2026-01-31', '2026-01-31', '2026-12-31');
    for (let i = 1; i < dates.length; i++) expect(dates[i]! > dates[i - 1]!).toBe(true);
    expect(dates).toContain('2026-02-28');
    expect(dates).toContain('2026-02-16');
  });
});
