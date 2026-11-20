import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addMonths } from './dates';
import {
  amortizedPayment,
  computeLoanMonths,
  monthlyInterest,
  projectPayoff,
  type LoanMonthInput,
  type LoanParams,
} from './loans';

describe('monthlyInterest', () => {
  it('is |balance| × APR / 12, rounded half away from zero', () => {
    expect(monthlyInterest(-10_000_000, '6')).toBe(50_000);
    expect(monthlyInterest(10_000_000, '6.0000')).toBe(50_000);
    expect(monthlyInterest(-12_345, '7.5')).toBe(77);
    expect(monthlyInterest(-12_345, '0')).toBe(0);
  });
});

describe('computeLoanMonths', () => {
  const months = [
    { month: '2026-01', transactionsTotal: -10_000_000, paymentsTotal: 0 },
    { month: '2026-02', transactionsTotal: 100_000, paymentsTotal: 100_000 },
  ];

  it('golden 9: charges interest only in months with a payment', () => {
    const [jan, feb] = computeLoanMonths({ apr: '6', escrow: 0 }, months);
    expect(jan).toMatchObject({ startBalance: 0, interest: 0, escrow: 0, endBalance: -10_000_000, principalPaid: 0 });
    expect(feb).toMatchObject({ startBalance: -10_000_000, interest: 50_000, endBalance: -9_950_000, principalPaid: 50_000 });
  });

  it('golden 9: takes escrow out of the payment before principal', () => {
    const [, feb] = computeLoanMonths({ apr: '6', escrow: 20_000 }, months);
    expect(feb).toMatchObject({ interest: 50_000, escrow: 20_000, endBalance: -9_970_000, principalPaid: 30_000 });
  });

  it('uses a per-month interest override when present', () => {
    const [, feb] = computeLoanMonths({ apr: '6', escrow: 0, interestOverrides: { '2026-02': 45_000 } }, months);
    expect(feb).toMatchObject({ interest: 45_000, endBalance: -9_945_000 });
  });

  it('carries the balance across months that are omitted', () => {
    const result = computeLoanMonths({ apr: '12', escrow: 0 }, [
      { month: '2026-01', transactionsTotal: -1_000_000, paymentsTotal: 0 },
      { month: '2026-05', transactionsTotal: 50_000, paymentsTotal: 50_000 },
    ]);
    expect(result[1]).toMatchObject({ startBalance: -1_000_000, interest: 10_000, endBalance: -960_000 });
  });

  it('counts only payments as principal when the loan is opened and paid in the same month', () => {
    const [jan] = computeLoanMonths({ apr: '6', escrow: 0 }, [
      { month: '2026-01', transactionsTotal: -10_000_000 + 100_000, paymentsTotal: 100_000 },
    ]);
    expect(jan).toMatchObject({ startBalance: 0, interest: 0, escrow: 0, principalPaid: 100_000, endBalance: -9_900_000 });
  });

  it('rejects a negative paymentsTotal', () => {
    expect(() =>
      computeLoanMonths({ apr: '6', escrow: 0 }, [{ month: '2026-01', transactionsTotal: -100, paymentsTotal: -100 }]),
    ).toThrow('paymentsTotal must be ≥ 0');
  });

  it('rejects amounts that are not safe integers', () => {
    const run = (params: Partial<LoanParams>, month: Partial<LoanMonthInput>) =>
      computeLoanMonths({ apr: '6', escrow: 0, ...params }, [
        { month: '2026-01', transactionsTotal: -100, paymentsTotal: 0, ...month },
      ]);
    const asMoney = (value: unknown) => value as number;
    expect(() => run({}, { transactionsTotal: asMoney('-100') })).toThrow(
      'transactionsTotal must be a safe integer amount, got -100',
    );
    expect(() => run({}, { paymentsTotal: 100.5 })).toThrow('paymentsTotal must be a safe integer amount, got 100.5');
    expect(() => run({ escrow: asMoney('20') }, {})).toThrow('escrow must be a safe integer amount, got 20');
    expect(() => run({ interestOverrides: { '2026-01': 0.5 } }, {})).toThrow(
      'interestOverrides[2026-01] must be a safe integer amount, got 0.5',
    );
  });
});

describe('amortizedPayment', () => {
  it('spreads principal evenly at 0 % APR', () => {
    expect(amortizedPayment(1_200_000, '0', 12)).toBe(100_000);
  });

  it('uses the annuity formula and rounds up', () => {
    expect(amortizedPayment(1_200_000, '12', 12)).toBe(106_619);
  });

  it('is zero when nothing is owed and rejects fewer than one month', () => {
    expect(amortizedPayment(0, '5', 10)).toBe(0);
    expect(() => amortizedPayment(1_000, '5', 0)).toThrow('amortizedPayment: months must be an integer ≥ 1, got 0');
  });

  it('rejects a non-integer number of months', () => {
    expect(() => amortizedPayment(1_000, '5', 1.5)).toThrow('amortizedPayment: months must be an integer ≥ 1, got 1.5');
  });

  it('rejects an invalid APR', () => {
    expect(() => amortizedPayment(1_000, 'abc', 12)).toThrow('Invalid decimal: "abc"');
  });

  it.each([
    // [principal, apr, months, minimal payment] — the float annuity gives 16_691, 128_324 and 2_285_423 for rows 1–3.
    [100_000, '0.5', 6, 16_692],
    [4_052_147, '24.99', 52, 128_325],
    [6_788_271, '6', 3, 2_285_422],
    [1_200_000, '12', 12, 106_619],
    [10_000_000, '6', 360, 59_956],
    [1_000, '0', 3, 334],
  ])('amortizedPayment(%i, %s, %i) is the minimal payment that pays off in time: %i', (principal, apr, months, expected) => {
    expect(amortizedPayment(principal, apr, months)).toBe(expected);
  });

  it('pays off 100_000 at 0.5 % within 6 months, where the float annuity payment would take 7', () => {
    const payoff = (payment: number) =>
      projectPayoff({ debt: -100_000, apr: '0.5', payment, escrow: 0, fromMonth: '2026-01' });
    expect(payoff(amortizedPayment(100_000, '0.5', 6))).toBe('2026-06');
    expect(payoff(16_691)).toBe('2026-07');
  });

  it('property: is the smallest payment that projectPayoff clears within the given months', () => {
    const FROM = '2000-01';
    const fits = (debt: number, apr: string, payment: number, months: number) => {
      const payoff = projectPayoff({ debt, apr, payment, escrow: 0, fromMonth: FROM });
      return payoff !== 'never' && payoff <= addMonths(FROM, months - 1);
    };
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.constantFrom('0', '0.5', '3.99', '6', '12', '24.99'),
        fc.integer({ min: 1, max: 360 }),
        (principal, apr, months) => {
          const payment = amortizedPayment(principal, apr, months);
          expect(fits(principal, apr, payment, months)).toBe(true);
          // A payment of 1 is the minimum possible; 0 can never clear a positive debt.
          if (payment > 1) expect(fits(principal, apr, payment - 1, months)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('negative APR', () => {
  // A negative rate shrinks the debt on its own; amortizedPayment('-2400', even months) used to loop forever.
  it.each(['-6', '-2400'])('rejects APR %s everywhere without hanging', (apr) => {
    const message = `APR must be ≥ 0, got "${apr}"`;
    expect(() => monthlyInterest(-100_000, apr)).toThrow(message);
    expect(() => amortizedPayment(1_000_000, apr, 12)).toThrow(message);
    expect(() => projectPayoff({ debt: -1_000_000, apr, payment: 100_000, escrow: 0, fromMonth: '2026-01' })).toThrow(
      message,
    );
    expect(() =>
      computeLoanMonths({ apr, escrow: 0 }, [{ month: '2026-01', transactionsTotal: 100, paymentsTotal: 100 }]),
    ).toThrow(message);
  });

  it('rejects a negative APR in computeLoanMonths when no month has a payment', () => {
    expect(() =>
      computeLoanMonths({ apr: '-6', escrow: 0 }, [{ month: '2026-01', transactionsTotal: -100_000, paymentsTotal: 0 }]),
    ).toThrow('APR must be ≥ 0, got "-6"');
  });

  it('rejects a negative APR in computeLoanMonths when overrides cover every payment month', () => {
    expect(() =>
      computeLoanMonths({ apr: '-6', escrow: 0, interestOverrides: { '2026-01': 500 } }, [
        { month: '2026-01', transactionsTotal: 10_000, paymentsTotal: 10_000 },
      ]),
    ).toThrow('APR must be ≥ 0, got "-6"');
  });
});

describe('projectPayoff', () => {
  it('returns the month of the final payment', () => {
    expect(projectPayoff({ debt: -1_200_000, apr: '0', payment: 100_000, escrow: 0, fromMonth: '2026-01' })).toBe('2026-12');
  });

  it('accounts for interest', () => {
    expect(projectPayoff({ debt: -1_200_000, apr: '12', payment: 106_619, escrow: 0, fromMonth: '2026-01' })).toBe('2026-12');
  });

  it('returns "never" when the payment does not cover interest and escrow', () => {
    expect(projectPayoff({ debt: -10_000_000, apr: '6', payment: 50_000, escrow: 0, fromMonth: '2026-01' })).toBe('never');
    expect(projectPayoff({ debt: -10_000_000, apr: '6', payment: 100_000, escrow: 60_000, fromMonth: '2026-01' })).toBe('never');
  });

  it('returns the start month when nothing is owed', () => {
    expect(projectPayoff({ debt: 0, apr: '6', payment: 1, escrow: 0, fromMonth: '2026-01' })).toBe('2026-01');
  });
});
