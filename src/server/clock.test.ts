import { describe, expect, it } from 'vitest';
import { monthIn, todayIn } from './clock';
import { FakeClock } from './test/fake-clock';

describe('todayIn / monthIn', () => {
  it('uses the configured zone, not UTC', () => {
    const lateNewYearsEveUtc = new Date('2026-12-31T23:30:00Z');
    expect(todayIn('Europe/Warsaw', lateNewYearsEveUtc)).toBe('2027-01-01');
    expect(todayIn('UTC', lateNewYearsEveUtc)).toBe('2026-12-31');
    expect(monthIn('Europe/Warsaw', lateNewYearsEveUtc)).toBe('2027-01');
  });

  it('handles daylight-saving transitions', () => {
    expect(todayIn('Europe/Warsaw', new Date('2026-03-29T00:30:00Z'))).toBe('2026-03-29');
    expect(todayIn('Europe/Warsaw', new Date('2026-10-24T22:30:00Z'))).toBe('2026-10-25');
  });
});

describe('FakeClock', () => {
  it('returns a fixed instant and advances on demand', () => {
    const clock = new FakeClock('2026-11-20T10:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-11-20T10:00:00.000Z');
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe('2026-11-20T10:01:30.000Z');
  });
});
