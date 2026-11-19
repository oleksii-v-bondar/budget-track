import type { Money } from './types';

/** n / d rounded half away from zero. */
export function roundDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('Division by zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const q = (abs * 2n + d) / (2n * d);
  return negative ? -q : q;
}

/** Parses a decimal string (e.g. "4.2512") into a bigint scaled by 10^scale, rounding half away from zero. */
export function parseDecimal(value: string, scale: number): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid decimal: "${value}"`);
  const sign = match[1] ?? '';
  const int = match[2] ?? '0';
  const frac = match[3] ?? '';
  const digits = BigInt(int + frac);
  const scaled = roundDiv(digits * 10n ** BigInt(scale), 10n ** BigInt(frac.length));
  return sign === '-' ? -scaled : scaled;
}

/** ceil(a / b) for a ≥ 0 and b > 0. */
export function ceilDiv(a: Money, b: number): Money {
  if (a < 0) throw new Error(`ceilDiv: numerator must be ≥ 0, got ${a}`);
  if (b <= 0) throw new Error(`ceilDiv: divisor must be > 0, got ${b}`);
  return Number((BigInt(a) + BigInt(b) - 1n) / BigInt(b));
}

/**
 * Splits `total` (≥ 0) proportionally to non-negative `weights` using largest-remainder rounding.
 * Remainder ties go to the lower index. The result always sums to `total` (unless all weights are 0).
 */
export function allocate(total: Money, weights: Money[]): Money[] {
  if (total < 0) throw new Error(`allocate: total must be ≥ 0, got ${total}`);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const bigTotal = BigInt(total);
  const bigSum = BigInt(sum);
  const parts = weights.map((w, index) => {
    const numerator = bigTotal * BigInt(w);
    return { index, quotient: numerator / bigSum, remainder: numerator % bigSum };
  });
  const result = parts.map((p) => Number(p.quotient));
  let left = total - result.reduce((s, x) => s + x, 0);
  const byRemainder = [...parts].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const p of byRemainder) {
    if (left <= 0) break;
    result[p.index] = (result[p.index] ?? 0) + 1;
    left -= 1;
  }
  return result;
}
