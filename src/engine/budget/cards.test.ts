import { describe, expect, it } from 'vitest';
import { cardPaymentShortfall, computeBudget } from './compute';
import {
  RTA,
  assign,
  budgetInput,
  cardLine,
  cardPayment,
  cardTransfer,
  cashLine,
  category,
} from './test-helpers';

const groceries = category('groceries');
const visa = cardPayment('visa');
const amex = cardPayment('amex');

describe('computeBudget: credit card payment categories', () => {
  it('moves funded card spending into the payment category', () => {
    const result = computeBudget(
      budgetInput({
        categories: [groceries, visa],
        assignments: [assign('2026-01', 'groceries', 10_000)],
        activity: [cardLine('2026-01', 'groceries', -7_000)],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['groceries']).toMatchObject({ available: 3_000, creditOverspent: 0 });
    expect(jan.categories['pay-visa']).toMatchObject({ activity: 7_000, available: 7_000 });
  });

  it('golden 1: cash spending is funded first; the unfunded card part is yellow credit overspending', () => {
    const result = computeBudget(
      budgetInput({
        categories: [groceries, visa],
        assignments: [assign('2026-01', 'groceries', 10_000)],
        activity: [cashLine('2026-01', 'groceries', -8_000), cardLine('2026-01', 'groceries', -5_000)],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['groceries']).toMatchObject({
      available: -3_000,
      cashOverspent: 0,
      creditOverspent: 3_000,
      creditOverByCard: { visa: 3_000 },
    });
    expect(jan.categories['pay-visa']).toMatchObject({ activity: 2_000, available: 2_000 });
  });

  it('golden 2: mixed overspending is red until the cash part is covered, then yellow', () => {
    const base = {
      categories: [groceries, visa],
      activity: [cashLine('2026-01', 'groceries', -2_000), cardLine('2026-01', 'groceries', -5_000)],
    };
    const at = (assigned: number) =>
      computeBudget(budgetInput({ ...base, assignments: [assign('2026-01', 'groceries', assigned)] })).byMonth['2026-01']!;

    expect(at(1_000).categories['groceries']).toMatchObject({ available: -6_000, cashOverspent: 1_000, creditOverspent: 5_000 });
    expect(at(1_000).categories['pay-visa']?.activity).toBe(0);

    expect(at(2_000).categories['groceries']).toMatchObject({ available: -5_000, cashOverspent: 0, creditOverspent: 5_000 });
    expect(at(2_000).categories['pay-visa']?.activity).toBe(0);

    expect(at(7_000).categories['groceries']).toMatchObject({ available: 0, cashOverspent: 0, creditOverspent: 0 });
    expect(at(7_000).categories['pay-visa']?.activity).toBe(5_000);
  });

  it('golden 3: a card refund moves money from the payment category back to the category', () => {
    const result = computeBudget(
      budgetInput({
        throughMonth: '2026-02',
        categories: [groceries, visa],
        assignments: [assign('2026-01', 'groceries', 10_000)],
        activity: [cardLine('2026-01', 'groceries', -10_000), cardLine('2026-02', 'groceries', 3_000)],
      }),
    );
    const feb = result.byMonth['2026-02']!;
    expect(feb.categories['groceries']).toMatchObject({ carry: 0, activity: 3_000, available: 3_000 });
    expect(feb.categories['pay-visa']).toMatchObject({ carry: 10_000, activity: -3_000, available: 7_000 });
  });

  it('golden 6: credit overspending does not carry and does not touch next month RTA', () => {
    const result = computeBudget(
      budgetInput({
        throughMonth: '2026-02',
        categories: [groceries, visa],
        activity: [cardLine('2026-01', 'groceries', -5_000)],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['groceries']).toMatchObject({ available: -5_000, creditOverspent: 5_000, cashOverspent: 0 });
    expect(jan.categories['pay-visa']?.available).toBe(0);
    const feb = result.byMonth['2026-02']!;
    expect(feb.categories['groceries']?.available).toBe(0);
    expect(feb.rta.cashOverspentPrev).toBe(0);
    expect(feb.rta.readyToAssign).toBe(0);
    expect(cardPaymentShortfall(-5_000, feb.categories['pay-visa']!.available)).toBe(5_000);
  });

  it('golden 7: card starting balance is covered by assigning to the payment category', () => {
    const withoutAssign = computeBudget(budgetInput({ categories: [visa], activity: [cashLine('2026-01', RTA, 50_000)] }));
    expect(cardPaymentShortfall(-37_500, withoutAssign.byMonth['2026-01']!.categories['pay-visa']!.available)).toBe(37_500);

    const withAssign = computeBudget(
      budgetInput({
        categories: [visa],
        activity: [cashLine('2026-01', RTA, 50_000)],
        assignments: [assign('2026-01', 'pay-visa', 37_500)],
      }),
    );
    const jan = withAssign.byMonth['2026-01']!;
    expect(cardPaymentShortfall(-37_500, jan.categories['pay-visa']!.available)).toBe(0);
    expect(jan.rta.readyToAssign).toBe(12_500);
  });

  it('golden 8: paying more than the payment category holds is cash overspending', () => {
    const result = computeBudget(
      budgetInput({
        throughMonth: '2026-02',
        categories: [visa],
        assignments: [assign('2026-01', 'pay-visa', 10_000)],
        cardTransfers: [cardTransfer('2026-01', 'visa', 15_000)],
      }),
    );
    expect(result.byMonth['2026-01']?.categories['pay-visa']).toMatchObject({
      activity: -15_000,
      available: -5_000,
      cashOverspent: 5_000,
      creditOverspent: 0,
    });
    expect(result.byMonth['2026-02']?.rta.cashOverspentPrev).toBe(5_000);
  });

  it('moves debt between payment categories on a card-to-card balance transfer', () => {
    const result = computeBudget(
      budgetInput({
        categories: [visa, amex],
        assignments: [assign('2026-01', 'pay-visa', 10_000)],
        cardTransfers: [cardTransfer('2026-01', 'visa', 10_000), cardTransfer('2026-01', 'amex', -10_000)],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['pay-visa']?.available).toBe(0);
    expect(jan.categories['pay-amex']?.available).toBe(10_000);
  });

  it('splits credit overspending across cards proportionally and funds the rest', () => {
    const result = computeBudget(
      budgetInput({
        categories: [groceries, visa, amex],
        assignments: [assign('2026-01', 'groceries', 2_000)],
        activity: [cardLine('2026-01', 'groceries', -3_000, 'visa'), cardLine('2026-01', 'groceries', -1_000, 'amex')],
      }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['groceries']?.creditOverByCard).toEqual({ visa: 1_500, amex: 500 });
    expect(jan.categories['pay-visa']?.activity).toBe(1_500);
    expect(jan.categories['pay-amex']?.activity).toBe(500);
  });

  it('counts RTA inflows on a card as income without touching the payment category', () => {
    const result = computeBudget(
      budgetInput({ categories: [visa], activity: [cardLine('2026-01', RTA, 1_200)] }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.rta.income).toBe(1_200);
    expect(jan.categories['pay-visa']?.activity).toBe(0);
  });

  it('flows Uncategorized card spending like any category (unfunded, so nothing moves)', () => {
    const result = computeBudget(
      budgetInput({ categories: [category('uncat', 'uncategorized'), visa], activity: [cardLine('2026-01', 'uncat', -900)] }),
    );
    const jan = result.byMonth['2026-01']!;
    expect(jan.categories['uncat']).toMatchObject({ available: -900, creditOverspent: 900 });
    expect(jan.categories['pay-visa']?.activity).toBe(0);
  });

  it('rejects transactions categorized to a payment category and cards without one', () => {
    expect(() =>
      computeBudget(budgetInput({ categories: [visa], activity: [cashLine('2026-01', 'pay-visa', -1)] })),
    ).toThrow('credit card payment category');
    expect(() =>
      computeBudget(budgetInput({ categories: [groceries], activity: [cardLine('2026-01', 'groceries', -1)] })),
    ).toThrow('no payment category');
    expect(() => computeBudget(budgetInput({ categories: [{ id: 'p', kind: 'cc_payment' }] }))).toThrow('linkedAccountId');
  });
});

describe('cardPaymentShortfall', () => {
  it('is the debt not yet covered by the payment category', () => {
    expect(cardPaymentShortfall(-57_000, 50_000)).toBe(7_000);
    expect(cardPaymentShortfall(-57_000, 60_000)).toBe(0);
    expect(cardPaymentShortfall(2_000, 0)).toBe(0);
  });
});
