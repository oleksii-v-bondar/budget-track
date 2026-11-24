import { describe, expect, it } from 'vitest';
import {
  budgetCategory,
  budgetGroup,
  budgetMonth,
  evaluation,
  monthlyTarget,
  sampleBudget,
} from '../test/budget-fixtures';
import { categoryHint, categoryStatus, rtaTone, splitHidden } from './view-model';

const hint = (fields: Parameters<typeof budgetCategory>[0]) => categoryHint(budgetCategory(fields));

describe('rtaTone', () => {
  it('is green above 0, red below and grey at 0 (spec §11)', () => {
    expect([rtaTone(1), rtaTone(-1), rtaTone(0)]).toEqual(['green', 'red', 'grey']);
  });
});

describe('categoryHint', () => {
  const base = { id: 'c', name: 'Rent' };
  const target = monthlyTarget('c', 50000);

  it('puts overspending first: cash before credit', () => {
    expect(hint({ ...base, cashOverspent: 100, creditOverspent: 50, targetEvaluation: evaluation(1, 1) })).toEqual({
      text: 'Overspent: move money to cover it',
      tone: 'bad',
    });
    expect(hint({ ...base, creditOverspent: 50, targetEvaluation: evaluation(1, 1) })).toEqual({
      text: 'Overspent on credit',
      tone: 'warn',
    });
  });

  it('asks for a category for Uncategorized activity, even when it is overspent', () => {
    expect(hint({ ...base, kind: 'uncategorized', activity: -500, cashOverspent: 500 })?.text).toBe(
      'Give these transactions a category',
    );
    expect(hint({ ...base, kind: 'uncategorized', available: 500 })).toBeNull();
  });

  it('says how a target stands', () => {
    const states = [
      evaluation(50000, 20000),
      evaluation(50000, 0),
      evaluation(50000, 0, { overfunded: true }),
      evaluation(50000, 0, { snoozed: true, progress: 0.2 }),
      evaluation(0, 0, { progress: 1 }),
      evaluation(0, 0, { progress: 0.5 }),
    ];
    expect(states.map((targetEvaluation) => hint({ ...base, target, targetEvaluation }))).toEqual([
      { text: '200,00\u00a0zł more needed this month', tone: 'warn' },
      { text: 'Funded', tone: 'good' },
      { text: 'Funded, with more than the target needs', tone: 'good' },
      { text: 'Target snoozed this month', tone: 'muted' },
      { text: 'Target reached', tone: 'muted' },
      { text: 'Nothing needed this month', tone: 'muted' },
    ]);
  });

  it("names what an incomplete debt target's account lacks", () => {
    const incomplete = evaluation(0, 0, { incomplete: true });
    const debt = (debtMode: 'min_payment' | 'payoff_by_date') =>
      hint({
        ...base,
        kind: 'cc_payment',
        target: { ...target, kind: 'debt', debtMode },
        targetEvaluation: incomplete,
      });
    expect(debt('min_payment')?.text).toBe("Add the account's minimum payment to finish this target");
    expect(debt('payoff_by_date')?.text).toBe("Add the account's APR to finish this target");
  });

  it('shows what a card payment needs when nothing else is to say', () => {
    expect(hint({ ...base, kind: 'cc_payment', needToPayInFull: 120000 })).toEqual({
      text: 'Need 1\u00a0200,00\u00a0zł to pay in full',
      tone: 'muted',
    });
    expect(hint({ ...base, kind: 'cc_payment', needToPayInFull: 0 })).toBeNull();
    expect(hint(base)).toBeNull();
  });
});

describe('categoryStatus', () => {
  const status = (fields: Partial<Parameters<typeof budgetCategory>[0]>) =>
    categoryStatus(budgetCategory({ id: 'c', name: 'Groceries', ...fields }));
  const target = monthlyTarget('c', 70000);

  it('says how the money stands: funded, partly spent or fully spent, with the spent part of the bar', () => {
    expect(status({ assigned: 390000, available: 390000 })).toEqual({
      text: 'Funded',
      tone: 'muted',
      bar: 'lime',
      filled: 1,
      spent: 0,
    });
    expect(
      status({ assigned: 70000, activity: -21500, available: 48500, target, targetEvaluation: evaluation(70000, 0) }),
    ).toEqual({
      text: 'Funded. Spent 215,00\u00a0zł of 700,00\u00a0zł',
      tone: 'muted',
      bar: 'lime',
      filled: 1,
      spent: 21500 / 70000,
    });
    expect(status({ assigned: 8000, activity: -8000 })).toMatchObject({ text: 'Fully Spent', bar: 'lime', spent: 1 });
    expect(status({ carry: 5000, activity: -5000 })).toMatchObject({ text: 'Fully Spent', spent: 1 });
  });

  it('puts overspending first, then a target that needs more', () => {
    const underfunded = evaluation(70000, 20000);
    expect(
      status({ activity: -9000, available: -1000, cashOverspent: 1000, target, targetEvaluation: underfunded }),
    ).toMatchObject({
      text: 'Overspent',
      tone: 'bad',
      bar: 'red',
    });
    expect(status({ activity: -1000, available: -1000, creditOverspent: 1000 })).toMatchObject({
      text: 'Overspent on credit',
      tone: 'warn',
      bar: 'yellow',
    });
    expect(status({ assigned: 50000, available: 50000, target, targetEvaluation: underfunded })).toEqual({
      text: '200,00\u00a0zł more needed this month',
      tone: 'warn',
      bar: 'yellow',
      filled: 50000 / 70000,
      spent: 0,
    });
  });

  it('has nothing to say about an empty category, and names a target with nothing to do', () => {
    expect(status({})).toEqual({ text: null, tone: 'muted', bar: 'empty', filled: 0, spent: 0 });
    expect(status({ target, targetEvaluation: evaluation(0, 0, { progress: 0.5 }) })).toMatchObject({
      text: 'Nothing needed this month',
      bar: 'empty',
    });
  });

  it('shows what a card payment needs, and Uncategorized activity', () => {
    expect(status({ kind: 'cc_payment', available: 5500, needToPayInFull: 35000 })).toMatchObject({
      text: 'Need 350,00\u00a0zł to pay in full',
      filled: 5500 / 40500,
    });
    expect(status({ kind: 'uncategorized', activity: -9900, available: -9900, cashOverspent: 9900 })).toMatchObject({
      text: 'Give these transactions a category',
      tone: 'warn',
      bar: 'red',
    });
  });
});

describe('splitHidden', () => {
  it('lists visible categories of visible groups and moves the rest to the hidden section', () => {
    const { groups, hidden } = splitHidden(sampleBudget());
    expect(groups.map((g) => [g.name, g.categories.map((c) => c.name)])).toEqual([
      ['Bills', ['Rent', 'Electricity']],
      ['Everyday', ['Groceries', 'Eating out', 'Fun money']],
      ['Credit Card Payments', ['Visa']],
    ]);
    expect(hidden.map((h) => [h.groupName, h.category.name])).toEqual([
      ['Everyday', 'Gifts'],
      ['Old stuff', 'Old hobby'],
    ]);
  });

  it("keeps the user's empty groups, so new ones show up, but not the app's empty payment groups", () => {
    const view = budgetMonth({
      groups: [
        budgetGroup({ id: 'g-cards', name: 'Credit Card Payments', kind: 'cc_payments' }),
        budgetGroup({ id: 'g-debts', name: 'Debt Payments', kind: 'debt_payments' }),
        budgetGroup({ id: 'g', name: 'New group' }),
      ],
    });
    expect(splitHidden(view).groups.map((g) => g.name)).toEqual(['New group']);
  });
});
