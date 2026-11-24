import { describe, expect, it } from 'vitest';
import { formatAmount, formatDate, formatDayHeading, formatMoney, formatMonth, formatMonthShort, NBSP, parseDate } from './format';

/** Writes expectations with plain spaces; the formatter uses no-break spaces. */
const nb = (text: string) => text.replaceAll(' ', NBSP);

describe('formatAmount and formatMoney', () => {
  it('group thousands with a space and use a decimal comma (spec §1)', () => {
    expect(formatMoney(123456)).toBe(nb('1 234,56 zł'));
    expect(formatMoney(0)).toBe(nb('0,00 zł'));
    expect(formatMoney(5)).toBe(nb('0,05 zł'));
    expect(formatMoney(99999)).toBe(nb('999,99 zł'));
    expect(formatMoney(100000000)).toBe(nb('1 000 000,00 zł'));
  });

  it('put a minus in front of negative amounts', () => {
    expect(formatMoney(-123456)).toBe(nb('-1 234,56 zł'));
    expect(formatAmount(-1)).toBe('-0,01');
    expect(formatAmount(-0)).toBe('0,00');
  });

  it('show foreign currencies by their code', () => {
    expect(formatMoney(250000, 'EUR')).toBe(nb('2 500,00 EUR'));
    expect(formatMoney(-75, 'USD')).toBe(nb('-0,75 USD'));
  });

  it('stay exact up to the largest safe integer and refuse anything else', () => {
    expect(formatAmount(Number.MAX_SAFE_INTEGER)).toBe(nb('90 071 992 547 409,91'));
    expect(formatAmount(-Number.MAX_SAFE_INTEGER)).toBe(nb('-90 071 992 547 409,91'));
    expect(() => formatAmount(1.5)).toThrow();
    expect(() => formatAmount(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});

describe('dates', () => {
  it('show ISO dates as dd.MM.yyyy', () => {
    expect(formatDate('2026-11-20')).toBe('20.11.2026');
    expect(formatDate('2027-01-05')).toBe('05.01.2027');
    expect(() => formatDate('20.11.2026')).toThrow();
  });

  it('parse dd.MM.yyyy back, refusing dates that do not exist', () => {
    expect(parseDate('20.11.2026')).toBe('2026-11-20');
    expect(parseDate(' 5.1.2027 ')).toBe('2027-01-05');
    expect(parseDate('29.02.2028')).toBe('2028-02-29');
    expect(parseDate('29.02.2027')).toBeNull();
    expect(parseDate('31.04.2027')).toBeNull();
    expect(parseDate('01.13.2027')).toBeNull();
    expect(parseDate('00.01.2027')).toBeNull();
    expect(parseDate('2027-01-05')).toBeNull();
  });
});

describe('month labels', () => {
  it('name the month in English', () => {
    expect(formatMonth('2026-11')).toBe('November 2026');
    expect(formatMonth('2027-01')).toBe('January 2027');
    expect(formatMonthShort('2026-09')).toBe('Sep 2026');
    expect(() => formatMonth('2026-13')).toThrow();
    expect(() => formatMonth('2026-11-01')).toThrow();
  });
});

describe('formatDayHeading', () => {
  it('writes the month out, without a leading zero on the day', () => {
    expect(formatDayHeading('2026-11-02')).toBe('November 2, 2026');
    expect(formatDayHeading('2026-01-31')).toBe('January 31, 2026');
    expect(() => formatDayHeading('2026-13-01')).toThrow();
  });
});
