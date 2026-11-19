import { describe, expect, it } from 'vitest';
import { allocate, ceilDiv, parseDecimal, roundDiv } from './money';

describe('roundDiv', () => {
  it('rounds half away from zero', () => {
    expect(roundDiv(5n, 2n)).toBe(3n);
    expect(roundDiv(-5n, 2n)).toBe(-3n);
    expect(roundDiv(7n, 3n)).toBe(2n);
    expect(roundDiv(8n, 3n)).toBe(3n);
    expect(roundDiv(4n, 2n)).toBe(2n);
    expect(roundDiv(5n, -2n)).toBe(-3n);
  });

  it('rejects division by zero', () => {
    expect(() => roundDiv(1n, 0n)).toThrow('Division by zero');
  });
});

describe('parseDecimal', () => {
  it('scales decimal strings to integers', () => {
    expect(parseDecimal('4.2512', 6)).toBe(4_251_200n);
    expect(parseDecimal('12', 4)).toBe(120_000n);
    expect(parseDecimal('-0.5', 1)).toBe(-5n);
  });

  it('rounds extra decimals half away from zero', () => {
    expect(parseDecimal('1.23455', 4)).toBe(12_346n);
    expect(parseDecimal('-1.23455', 4)).toBe(-12_346n);
  });

  it('rejects malformed input', () => {
    expect(() => parseDecimal('1,5', 2)).toThrow('Invalid decimal');
    expect(() => parseDecimal('', 2)).toThrow('Invalid decimal');
  });
});

describe('ceilDiv', () => {
  it('rounds up for non-negative numerators', () => {
    expect(ceilDiv(100, 3)).toBe(34);
    expect(ceilDiv(99, 3)).toBe(33);
    expect(ceilDiv(0, 7)).toBe(0);
  });

  it('rejects negative numerators and non-positive divisors', () => {
    expect(() => ceilDiv(-1, 3)).toThrow();
    expect(() => ceilDiv(1, 0)).toThrow();
  });
});

describe('allocate', () => {
  it('splits proportionally with largest-remainder rounding', () => {
    expect(allocate(20, [30, 10])).toEqual([15, 5]);
    expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocate(5, [2, 3])).toEqual([2, 3]);
  });

  it('breaks remainder ties in favour of the earlier index', () => {
    expect(allocate(1, [1, 1])).toEqual([1, 0]);
  });

  it('returns zeros when there is nothing to allocate', () => {
    expect(allocate(0, [3, 4])).toEqual([0, 0]);
    expect(allocate(5, [0, 0])).toEqual([0, 0]);
    expect(allocate(5, [])).toEqual([]);
  });

  it('always sums to the total', () => {
    const parts = allocate(1_000_003, [7, 13, 29, 51]);
    expect(parts.reduce((s, x) => s + x, 0)).toBe(1_000_003);
  });

  it('rejects a negative total', () => {
    expect(() => allocate(-1, [1])).toThrow();
  });
});
