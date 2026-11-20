import { describe, expect, it } from 'vitest';
import { autoAssign } from './autoAssign';
import { computeBudget } from './budget/compute';
import { RTA, assign, budgetInput, cashLine, category } from './budget/test-helpers';

// Jan: assigned groceries 30 000 / rent 100 000, spent groceries 25 000 / rent 100 000.
// Feb: assigned groceries 50 000 / rent 100 000, spent groceries 45 000 / rent 100 000.
// Mar: assigned groceries 10 000, spent groceries 4 000. Income 500 000 in Jan.
const budget = computeBudget(
  budgetInput({
    throughMonth: '2026-03',
    categories: [category('groceries'), category('rent'), category('fun')],
    activity: [
      cashLine('2026-01', RTA, 500_000),
      cashLine('2026-01', 'groceries', -25_000),
      cashLine('2026-01', 'rent', -100_000),
      cashLine('2026-02', 'groceries', -45_000),
      cashLine('2026-02', 'rent', -100_000),
      cashLine('2026-03', 'groceries', -4_000),
    ],
    assignments: [
      assign('2026-01', 'groceries', 30_000),
      assign('2026-01', 'rent', 100_000),
      assign('2026-02', 'groceries', 50_000),
      assign('2026-02', 'rent', 100_000),
      assign('2026-03', 'groceries', 10_000),
    ],
  }),
);
// RTA in March = 500 000 − 290 000 = 210 000
const all = ['groceries', 'rent', 'fun'];

describe('autoAssign', () => {
  it('underfunded: fills in display order and stops when RTA runs out', () => {
    const changes = autoAssign({
      strategy: 'underfunded',
      month: '2026-03',
      categoryIds: all,
      budget,
      underfunded: { groceries: 40_000, rent: 100_000, fun: 200_000 },
    });
    expect(changes).toEqual([
      { categoryId: 'groceries', from: 10_000, to: 50_000 },
      { categoryId: 'rent', from: 0, to: 100_000 },
      { categoryId: 'fun', from: 0, to: 70_000 },
    ]);
  });

  it('underfunded: does nothing when RTA is not positive', () => {
    const broke = computeBudget(budgetInput({ categories: [category('fun')] }));
    expect(
      autoAssign({ strategy: 'underfunded', month: '2026-01', categoryIds: ['fun'], budget: broke, underfunded: { fun: 5 } }),
    ).toEqual([]);
  });

  it('underfunded: ignores negative underfunded amounts instead of un-assigning', () => {
    const small = computeBudget(
      budgetInput({ categories: [category('a'), category('b')], activity: [cashLine('2026-01', RTA, 100)] }),
    );
    expect(
      autoAssign({ strategy: 'underfunded', month: '2026-01', categoryIds: ['a', 'b'], budget: small, underfunded: { a: -50, b: 500 } }),
    ).toEqual([{ categoryId: 'b', from: 0, to: 100 }]);
  });

  it('assigned last month', () => {
    expect(autoAssign({ strategy: 'assigned_last_month', month: '2026-03', categoryIds: all, budget })).toEqual([
      { categoryId: 'groceries', from: 10_000, to: 50_000 },
      { categoryId: 'rent', from: 0, to: 100_000 },
    ]);
  });

  it('spent last month', () => {
    expect(autoAssign({ strategy: 'spent_last_month', month: '2026-03', categoryIds: ['groceries'], budget })).toEqual([
      { categoryId: 'groceries', from: 10_000, to: 45_000 },
    ]);
  });

  it('average assigned and average spent use the previous months since budget start', () => {
    expect(autoAssign({ strategy: 'average_assigned', month: '2026-03', categoryIds: ['groceries'], budget })).toEqual([
      { categoryId: 'groceries', from: 10_000, to: 40_000 },
    ]);
    expect(autoAssign({ strategy: 'average_spent', month: '2026-03', categoryIds: ['groceries'], budget })).toEqual([
      { categoryId: 'groceries', from: 10_000, to: 35_000 },
    ]);
  });

  it('reset available brings Available to zero; reset assigned clears the assignment', () => {
    // groceries March: carry 10 000 + assigned 10 000 − spent 4 000 = 16 000 available
    expect(autoAssign({ strategy: 'reset_available', month: '2026-03', categoryIds: ['groceries'], budget })).toEqual([
      { categoryId: 'groceries', from: 10_000, to: -6_000 },
    ]);
    expect(autoAssign({ strategy: 'reset_assigned', month: '2026-03', categoryIds: ['groceries'], budget })).toEqual([
      { categoryId: 'groceries', from: 10_000, to: 0 },
    ]);
  });

  it('treats months before the budget start as empty', () => {
    expect(autoAssign({ strategy: 'assigned_last_month', month: '2026-01', categoryIds: ['groceries'], budget })).toEqual([
      { categoryId: 'groceries', from: 30_000, to: 0 },
    ]);
  });

  it('rejects underfunded amounts that are not safe integers', () => {
    const run = (underfunded: Record<string, number>) =>
      autoAssign({ strategy: 'underfunded', month: '2026-03', categoryIds: all, budget, underfunded });
    expect(() => run({ groceries: '100' as unknown as number })).toThrow(
      'underfunded.groceries must be a safe integer amount, got 100',
    );
    expect(() => run({ rent: 100.5 })).toThrow('underfunded.rent must be a safe integer amount, got 100.5');
  });

  it('requires underfunded amounts for the underfunded strategy', () => {
    expect(() => autoAssign({ strategy: 'underfunded', month: '2026-03', categoryIds: all, budget })).toThrow('underfunded');
  });
});
