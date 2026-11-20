import { describe, expect, it } from 'vitest';
import { convertToBase, effectiveRate, revaluationDiff, splitLineBases, transferBases } from './fx';

describe('convertToBase', () => {
  it('multiplies by the rate and rounds half away from zero', () => {
    expect(convertToBase(10_000, '4.2512')).toBe(42_512);
    expect(convertToBase(-333, '4.3215')).toBe(-1_439);
    expect(convertToBase(1, '0.5')).toBe(1);
    expect(convertToBase(-1, '0.5')).toBe(-1);
  });
});

describe('splitLineBases', () => {
  it('gives the rounding remainder to the last line', () => {
    expect(splitLineBases(333, [500, 500], '0.333333')).toEqual([167, 166]);
  });

  it('always sums to the parent base amount', () => {
    const lines = splitLineBases(4_333, [333, 333, 334], '4.33333');
    expect(lines.reduce((s, x) => s + x, 0)).toBe(4_333);
  });

  it('handles no lines', () => {
    expect(splitLineBases(0, [], '4')).toEqual([]);
  });
});

describe('transferBases', () => {
  it('golden 11: PLN → EUR uses the PLN amount on both sides so the budget nets to zero', () => {
    expect(
      transferBases('PLN', { amount: -40_000, currency: 'PLN', rate: null }, { amount: 9_300, currency: 'EUR', rate: '4.25' }),
    ).toEqual({ fromBase: -40_000, toBase: 40_000 });
  });

  it('EUR → PLN uses the PLN side', () => {
    expect(
      transferBases('PLN', { amount: -9_300, currency: 'EUR', rate: '4.25' }, { amount: 40_000, currency: 'PLN', rate: null }),
    ).toEqual({ fromBase: -40_000, toBase: 40_000 });
  });

  it('foreign → foreign converts the source side', () => {
    expect(
      transferBases('PLN', { amount: -10_000, currency: 'EUR', rate: '4.3' }, { amount: 11_500, currency: 'USD', rate: '3.9' }),
    ).toEqual({ fromBase: -43_000, toBase: 43_000 });
  });

  it('requires a rate for a foreign source', () => {
    expect(() =>
      transferBases('PLN', { amount: -1, currency: 'EUR', rate: null }, { amount: 1, currency: 'USD', rate: null }),
    ).toThrow('rate');
  });
});

describe('money argument validation', () => {
  const asMoney = (value: unknown) => value as number;
  const pln = (amount: number) => ({ amount, currency: 'PLN', rate: null });

  it('rejects string and fractional amounts', () => {
    expect(() => convertToBase(asMoney('100'), '4')).toThrow('amount must be a safe integer amount, got 100');
    expect(() => convertToBase(100.5, '4')).toThrow('amount must be a safe integer amount, got 100.5');
    expect(() => splitLineBases(asMoney('100'), [100], '1')).toThrow('parentBase must be a safe integer amount, got 100');
    expect(() => splitLineBases(100, [50, 50.5], '1')).toThrow('line amount must be a safe integer amount, got 50.5');
    expect(() => transferBases('PLN', pln(asMoney('-100')), pln(100))).toThrow(
      'from.amount must be a safe integer amount, got -100',
    );
    expect(() => transferBases('PLN', pln(-100), pln(100.5))).toThrow('to.amount must be a safe integer amount, got 100.5');
    expect(() => revaluationDiff(asMoney('100'), '4', 400)).toThrow('nativeBalance must be a safe integer amount, got 100');
    expect(() => revaluationDiff(100, '4', 400.5)).toThrow('bookedBase must be a safe integer amount, got 400.5');
  });
});

describe('effectiveRate and revaluationDiff', () => {
  it('formats the implied rate with 6 decimals', () => {
    expect(effectiveRate(9_300, -40_000)).toBe('4.301075');
    expect(effectiveRate(0, 100)).toBeNull();
  });

  it('golden 11: revaluation is today’s value minus the booked base amounts', () => {
    expect(revaluationDiff(100_000, '4.30', 425_000)).toBe(5_000);
    expect(revaluationDiff(100_000, '4.20', 425_000)).toBe(-5_000);
  });
});
