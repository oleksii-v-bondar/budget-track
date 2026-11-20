import { describe, expect, it } from 'vitest';
import { amortizedPayment, computeLoanMonths, monthlyInterest, projectPayoff } from './loans';

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
    { month: '2026-01', transactionsTotal: -10_000_000, hasPayment: false },
    { month: '2026-02', transactionsTotal: 100_000, hasPayment: true },
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
      { month: '2026-01', transactionsTotal: -1_000_000, hasPayment: false },
      { month: '2026-05', transactionsTotal: 50_000, hasPayment: true },
    ]);
    expect(result[1]).toMatchObject({ startBalance: -1_000_000, interest: 10_000, endBalance: -960_000 });
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
    expect(() => amortizedPayment(1_000, '5', 0)).toThrow();
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
