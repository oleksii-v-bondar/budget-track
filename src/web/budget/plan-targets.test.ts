import { describe, expect, it } from 'vitest';
import { budgetCategory, budgetGroup, budgetMonth, evaluation, monthlyTarget } from '../test/budget-fixtures';
import { costToBeMe, monthlyTargetAmount, targetCadenceLabel } from './plan-targets';

const withTarget = (fields: Parameters<typeof monthlyTarget>[2], need?: number) =>
  budgetCategory({
    id: 'c',
    name: 'C',
    target: monthlyTarget('c', 120_000, fields),
    targetEvaluation: need === undefined ? null : evaluation(need, 0),
  });

describe('monthlyTargetAmount', () => {
  it('is null without a target', () => {
    expect(monthlyTargetAmount(budgetCategory({ id: 'c', name: 'C' }), '2026-11')).toBeNull();
  });

  it('takes a monthly target as it is', () => {
    expect(monthlyTargetAmount(withTarget({}), '2026-11')).toBe(120_000);
  });

  it('multiplies a weekly target by the occurrences of its weekday in the month', () => {
    const mondays = withTarget({ cadence: 'weekly', amount: 35_000, dueWeekday: 1 });
    // November 2026 has five Mondays, December 2026 four.
    expect(monthlyTargetAmount(mondays, '2026-11')).toBe(175_000);
    expect(monthlyTargetAmount(mondays, '2026-12')).toBe(140_000);
  });

  it('spreads yearly and repeating targets evenly over their cycle, rounded', () => {
    expect(monthlyTargetAmount(withTarget({ cadence: 'yearly', amount: 100_000, dueDate: '2027-03-01' }), '2026-11')).toBe(8_333);
    const every = (repeatEvery: number, repeatUnit: 'month' | 'year') =>
      withTarget({ cadence: 'custom', amount: 100_000, dueDate: '2027-03-01', repeatUnit, repeatEvery });
    expect(monthlyTargetAmount(every(3, 'month'), '2026-11')).toBe(33_333);
    expect(monthlyTargetAmount(every(2, 'month'), '2026-11')).toBe(50_000);
    expect(monthlyTargetAmount(every(2, 'year'), '2026-11')).toBe(4_167);
  });

  it("takes a by-date target's need this month, else spreads it over the months left", () => {
    const oneOff = { cadence: 'custom', amount: 100_000, dueDate: '2027-01-15' } as const;
    expect(monthlyTargetAmount(withTarget(oneOff, 40_000), '2026-11')).toBe(40_000);
    // Not started yet (no evaluation): November to January is three months.
    expect(monthlyTargetAmount(withTarget(oneOff), '2026-11')).toBe(33_334);
    const balance = { kind: 'balance', cadence: 'none', mode: null, amount: 100_000, dueDate: '2027-01-15' } as const;
    expect(monthlyTargetAmount(withTarget(balance, 25_000), '2026-11')).toBe(25_000);
    // A balance to keep with no date costs nothing a month.
    expect(monthlyTargetAmount(withTarget({ ...balance, dueDate: null }, 100_000), '2026-11')).toBe(0);
  });

  it("takes a debt target's minimum payment (the need) or its fixed amount", () => {
    const debt = { kind: 'debt', cadence: 'monthly', mode: null } as const;
    expect(monthlyTargetAmount(withTarget({ ...debt, debtMode: 'min_payment', amount: 0 }, 15_000), '2026-11')).toBe(15_000);
    expect(monthlyTargetAmount(withTarget({ ...debt, debtMode: 'fixed', amount: 50_000 }, 50_000), '2026-11')).toBe(50_000);
    expect(monthlyTargetAmount(withTarget({ ...debt, debtMode: 'payoff_by_date', amount: 0, dueDate: '2027-06-01' }, 80_000), '2026-11')).toBe(80_000);
    expect(monthlyTargetAmount(withTarget({ ...debt, debtMode: 'min_payment', amount: 0 }), '2026-11')).toBe(0);
  });
});

describe('costToBeMe', () => {
  it("sums every live category's monthly target, hidden ones included", () => {
    const view = budgetMonth({
      groups: [
        budgetGroup({
          id: 'g',
          name: 'G',
          categories: [
            budgetCategory({ id: 'a', name: 'A', target: monthlyTarget('a', 390_000) }),
            budgetCategory({ id: 'b', name: 'B', target: monthlyTarget('b', 35_000, { cadence: 'weekly', dueWeekday: 2 }) }),
            budgetCategory({ id: 'c', name: 'C' }),
          ],
        }),
        budgetGroup({
          id: 'h',
          name: 'H',
          hidden: true,
          categories: [budgetCategory({ id: 'd', name: 'D', target: monthlyTarget('d', 4_000) })],
        }),
      ],
    });
    // November 2026 has four Tuesdays.
    expect(costToBeMe(view)).toBe(390_000 + 140_000 + 4_000);
  });
});

describe('targetCadenceLabel', () => {
  // formatMoney groups digits and joins the currency with no-break spaces.
  const label = (fields: Parameters<typeof monthlyTarget>[2]) =>
    targetCadenceLabel(monthlyTarget('c', 35_000, fields))?.replaceAll('\u00a0', ' ') ?? null;

  it('names every cadence but monthly, with the amount the target asks for', () => {
    expect(label({ cadence: 'weekly', dueWeekday: 1 })).toBe('350,00 zł Weekly');
    expect(label({})).toBeNull();
    expect(label({ cadence: 'yearly', dueDate: '2027-03-01' })).toBe('350,00 zł Yearly');
    expect(label({ cadence: 'custom', dueDate: '2027-03-01', repeatUnit: 'month', repeatEvery: 3 })).toBe(
      '350,00 zł Every 3 months',
    );
    expect(label({ cadence: 'custom', dueDate: '2027-03-01', repeatUnit: 'year', repeatEvery: 2 })).toBe(
      '350,00 zł Every 2 years',
    );
    expect(label({ cadence: 'custom', dueDate: '2027-03-01' })).toBe('350,00 zł By 01.03.2027');
    expect(label({ kind: 'balance', cadence: 'none', dueDate: '2027-03-01' })).toBe('350,00 zł By 01.03.2027');
    expect(label({ kind: 'balance', cadence: 'none' })).toBe('Have 350,00 zł');
    expect(label({ kind: 'debt', debtMode: 'min_payment', amount: 0 })).toBe('Minimum payment');
    expect(label({ kind: 'debt', debtMode: 'fixed' })).toBeNull();
    expect(label({ kind: 'debt', debtMode: 'payoff_by_date', dueDate: '2027-06-01' })).toBe('Pay off by 01.06.2027');
  });
});
