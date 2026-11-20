import { describe, expect, it } from 'vitest';
import { computeBudget } from './compute';
import { RTA, assign, budgetInput, cashLine, category } from './test-helpers';
import type { BudgetInput } from './types';

const groceries = category('groceries');
const rent = category('rent');

describe('computeBudget: categories and Ready to Assign', () => {
  it('puts income into Ready to Assign', () => {
    const result = computeBudget(budgetInput({ activity: [cashLine('2026-01', RTA, 100_000)] }));
    expect(result.byMonth['2026-01']?.rta).toEqual({
      leftoverPrev: 0,
      income: 100_000,
      assignedThisMonth: 0,
      assignedFuture: 0,
      cashOverspentPrev: 0,
      leftover: 100_000,
      readyToAssign: 100_000,
    });
  });

  it('moves assigned money from RTA to the category and subtracts spending', () => {
    const result = computeBudget(
      budgetInput({
        categories: [groceries],
        activity: [cashLine('2026-01', RTA, 100_000), cashLine('2026-01', 'groceries', -10_000)],
        assignments: [assign('2026-01', 'groceries', 30_000)],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.rta.readyToAssign).toBe(70_000);
    expect(jan.categories['groceries']).toMatchObject({ carry: 0, assigned: 30_000, activity: -10_000, available: 20_000 });
  });

  it('carries positive Available into the next month', () => {
    const result = computeBudget(
      budgetInput({
        throughMonth: '2026-02',
        categories: [groceries],
        activity: [cashLine('2026-01', RTA, 50_000), cashLine('2026-01', 'groceries', -10_000)],
        assignments: [assign('2026-01', 'groceries', 30_000)],
      }),
    );
    const feb = result.byMonth['2026-02']!;
    expect(feb.categories['groceries']).toMatchObject({ carry: 20_000, assigned: 0, activity: 0, available: 20_000 });
    expect(feb.rta.leftoverPrev).toBe(20_000);
    expect(feb.rta.readyToAssign).toBe(20_000);
  });

  it('golden 4: assigning in a future month reduces RTA now', () => {
    const result = computeBudget(
      budgetInput({
        categories: [rent],
        activity: [cashLine('2026-01', RTA, 20_000)],
        assignments: [assign('2026-02', 'rent', 20_000)],
      }),
    );
    expect(result.months).toEqual(['2026-01', '2026-02']);
    expect(result.byMonth['2026-01']?.rta).toMatchObject({ leftover: 20_000, assignedFuture: 20_000, readyToAssign: 0 });
    expect(result.byMonth['2026-02']?.rta).toMatchObject({ leftover: 0, assignedFuture: 0, readyToAssign: 0 });
    expect(result.byMonth['2026-02']?.categories['rent']?.available).toBe(20_000);
  });

  it('golden 5: cash overspending resets the category and is deducted from next month RTA', () => {
    const result = computeBudget(
      budgetInput({
        throughMonth: '2026-02',
        categories: [groceries],
        activity: [cashLine('2026-01', 'groceries', -5_000)],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['groceries']).toMatchObject({ available: -5_000, cashOverspent: 5_000, creditOverspent: 0 });
    expect(jan.cashOverspentTotal).toBe(5_000);
    expect(jan.rta.readyToAssign).toBe(0);
    const feb = result.byMonth['2026-02']!;
    expect(feb.categories['groceries']).toMatchObject({ carry: 0, available: 0 });
    expect(feb.rta).toMatchObject({ cashOverspentPrev: 5_000, leftover: -5_000, readyToAssign: -5_000 });
  });

  it('treats a negative assignment that drives Available below zero as cash overspending', () => {
    const result = computeBudget(
      budgetInput({ categories: [groceries], assignments: [assign('2026-01', 'groceries', -3_000)] }),
    );
    expect(result.byMonth['2026-01']?.categories['groceries']).toMatchObject({ available: -3_000, cashOverspent: 3_000 });
    expect(result.byMonth['2026-01']?.rta.readyToAssign).toBe(3_000);
  });

  it('applies normal rules to the Uncategorized category', () => {
    const result = computeBudget(
      budgetInput({ categories: [category('uncat', 'uncategorized')], activity: [cashLine('2026-01', 'uncat', -700)] }),
    );
    expect(result.byMonth['2026-01']?.categories['uncat']).toMatchObject({ available: -700, cashOverspent: 700 });
  });

  it('rejects assigning money to the Uncategorized category', () => {
    expect(() =>
      computeBudget(
        budgetInput({ categories: [category('uncat', 'uncategorized')], assignments: [assign('2026-01', 'uncat', 700)] }),
      ),
    ).toThrow('Cannot assign to the Uncategorized category');
  });

  it('widens the month range to cover all data', () => {
    const result = computeBudget(
      budgetInput({
        startMonth: '2026-03',
        throughMonth: '2026-03',
        categories: [groceries],
        activity: [cashLine('2026-01', RTA, 1_000)],
        assignments: [assign('2026-05', 'groceries', 1_000)],
      }),
    );
    expect(result.months).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
  });

  it('rejects activity and assignments for unknown categories', () => {
    expect(() => computeBudget(budgetInput({ activity: [cashLine('2026-01', 'nope', -1)] }))).toThrow('unknown category');
    expect(() => computeBudget(budgetInput({ assignments: [assign('2026-01', RTA, 1)] }))).toThrow('unknown category');
  });

  it('rejects listing the RTA category as a regular category', () => {
    expect(() => computeBudget(budgetInput({ categories: [category(RTA)] }))).toThrow('RTA');
  });
});

describe('computeBudget: input validation', () => {
  // postgres sum() returns numeric columns as strings, so a missed cast would reach the engine as '100'.
  const asMoney = (value: unknown) => value as number;

  it.each([
    ['a string', asMoney('100'), '100'],
    ['a fractional', 100.5, '100.5'],
    ['an unsafe', 2 ** 53, String(2 ** 53)],
  ])('rejects %s amount in every row type', (_, amount, shown) => {
    expect(() => computeBudget(budgetInput({ activity: [cashLine('2026-01', RTA, amount)] }))).toThrow(
      `activity amount must be a safe integer amount, got ${shown}`,
    );
    expect(() =>
      computeBudget(budgetInput({ categories: [groceries], assignments: [assign('2026-01', 'groceries', amount)] })),
    ).toThrow(`assignment amount must be a safe integer amount, got ${shown}`);
    expect(() =>
      computeBudget(
        budgetInput({
          categories: [{ id: 'pay-visa', kind: 'cc_payment', linkedAccountId: 'visa' }],
          cardTransfers: [{ month: '2026-01', cardAccountId: 'visa', amount }],
        }),
      ),
    ).toThrow(`card transfer amount must be a safe integer amount, got ${shown}`);
  });

  it('rejects months that are not YYYY-MM', () => {
    expect(() => computeBudget(budgetInput({ startMonth: '2026-01-01' }))).toThrow('Invalid month: "2026-01-01"');
    expect(() => computeBudget(budgetInput({ throughMonth: '2026-13' }))).toThrow('Invalid month: "2026-13"');
    // Rows inside [start, through] would otherwise be keyed under a month that never matches and silently dropped.
    const sixMonths = (partial: Partial<BudgetInput>) =>
      budgetInput({
        throughMonth: '2026-06',
        categories: [groceries, { id: 'pay-visa', kind: 'cc_payment', linkedAccountId: 'visa' }],
        ...partial,
      });
    expect(() => computeBudget(sixMonths({ activity: [cashLine('2026-03-15', RTA, 1)] }))).toThrow(
      'Invalid month: "2026-03-15"',
    );
    expect(() => computeBudget(sixMonths({ assignments: [assign('2026-02-01', 'groceries', 1)] }))).toThrow(
      'Invalid month: "2026-02-01"',
    );
    expect(() =>
      computeBudget(sixMonths({ cardTransfers: [{ month: '2026-04-30', cardAccountId: 'visa', amount: 1 }] })),
    ).toThrow('Invalid month: "2026-04-30"');
  });

  it('rejects a start month after the through month', () => {
    expect(() => computeBudget(budgetInput({ startMonth: '2026-03', throughMonth: '2026-02' }))).toThrow(
      'startMonth 2026-03 must not be after throughMonth 2026-02',
    );
  });

  it('rejects duplicate category ids', () => {
    expect(() => computeBudget(budgetInput({ categories: [groceries, rent, category('groceries')] }))).toThrow(
      'Duplicate category id groceries',
    );
  });

  it('rejects two payment categories for the same credit account', () => {
    const categories = [
      { id: 'pay-visa', kind: 'cc_payment', linkedAccountId: 'visa' },
      { id: 'pay-visa-2', kind: 'cc_payment', linkedAccountId: 'visa' },
    ] as const;
    expect(() => computeBudget(budgetInput({ categories: [...categories] }))).toThrow(
      'Credit account visa has more than one payment category',
    );
  });
});
