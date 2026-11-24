import { describe, expect, it } from 'vitest';
import { budgetCategory, budgetGroup, budgetMonth, rtaBreakdown, sampleBudget } from '../test/budget-fixtures';
import { chartMonths, incomeVsSpending, spendingBreakdown, spendingByCategory } from './reflect-model';

const spent = (id: string, activity: number) => budgetCategory({ id, name: id, activity });

describe('spendingByCategory', () => {
  it("lists the month's net outflows, most first, without card payments or net inflows", () => {
    expect(spendingByCategory(sampleBudget())).toEqual([
      { id: 'c-groceries', name: 'Groceries', spent: 58000 },
      { id: 'c-eating', name: 'Eating out', spent: 3000 },
      { id: 'c-uncategorized', name: 'Uncategorized Transactions', spent: 2500 },
    ]);
  });
});

describe('spendingBreakdown', () => {
  it('keeps the top five categories, adds the rest up as All Others, and totals everything', () => {
    const view = budgetMonth({
      groups: [
        budgetGroup({
          id: 'g',
          name: 'Everything',
          categories: [
            spent('a', -100),
            spent('b', -700),
            spent('c', -300),
            spent('d', -50),
            spent('e', -400),
            spent('f', -20),
            spent('g', -30),
          ],
        }),
      ],
    });
    const { total, slices } = spendingBreakdown(view);
    expect(total).toBe(1600);
    expect(slices.map((s) => [s.name, s.spent])).toEqual([
      ['b', 700],
      ['e', 400],
      ['c', 300],
      ['a', 100],
      ['d', 50],
      ['All Others', 50],
    ]);
    expect(new Set(slices.map((s) => s.color)).size).toBe(6);
  });

  it('has no All Others when five categories or fewer spent', () => {
    expect(spendingBreakdown(sampleBudget()).slices.map((s) => s.name)).toEqual([
      'Groceries',
      'Eating out',
      'Uncategorized Transactions',
    ]);
    expect(spendingBreakdown(budgetMonth())).toEqual({ total: 0, slices: [] });
  });
});

describe('incomeVsSpending', () => {
  const month = (m: string, income: number, activity: number) =>
    budgetMonth({
      month: m,
      rta: rtaBreakdown(0, { income }),
      groups: [budgetGroup({ id: 'g', name: 'G', categories: [spent(`x-${m}`, activity)] })],
    });

  it('shows the last six months, months without a view as 0', () => {
    expect(chartMonths('2026-02')).toEqual(['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
    const { totals } = incomeVsSpending(chartMonths('2026-11'), [
      month('2026-10', 500, -300),
      month('2026-11', 100, -200),
    ]);
    expect(totals).toEqual([
      { month: '2026-06', income: 0, spending: 0 },
      { month: '2026-07', income: 0, spending: 0 },
      { month: '2026-08', income: 0, spending: 0 },
      { month: '2026-09', income: 0, spending: 0 },
      { month: '2026-10', income: 500, spending: 300 },
      { month: '2026-11', income: 100, spending: 200 },
    ]);
  });

  it('compares the averages of the months there are', () => {
    const months = chartMonths('2026-11');
    expect(incomeVsSpending(months, [month('2026-10', 500, -300), month('2026-11', 100, -200)]).summary).toBe(
      'On average, you’re making more than you spend.',
    );
    expect(incomeVsSpending(months, [month('2026-10', 100, -300), month('2026-11', 300, -200)]).summary).toBe(
      'On average, you’re spending more than you make.',
    );
    expect(incomeVsSpending(months, []).summary).toBeNull();
  });
});
