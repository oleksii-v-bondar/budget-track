import { describe, expect, it } from 'vitest';
import { evaluateTarget, pillColor, type TargetContext, type TargetDef } from './targets';

function target(partial: Partial<TargetDef>): TargetDef {
  return {
    kind: 'spending',
    cadence: 'monthly',
    amount: 0,
    mode: 'set_aside',
    dueWeekday: null,
    dueDayOfMonth: null,
    dueDate: null,
    repeatUnit: null,
    repeatEvery: null,
    startMonth: '2026-01',
    debtMode: null,
    snoozedMonth: null,
    ...partial,
  };
}

function ctx(partial: Partial<TargetContext>): TargetContext {
  return { month: '2026-01', carry: 0, assigned: 0, available: 0, assignedIn: () => 0, ...partial };
}

describe('spending targets: weekly and monthly', () => {
  it('weekly: need is the amount times the number of matching weekdays', () => {
    const t = target({ cadence: 'weekly', amount: 10_000, dueWeekday: 1 });
    expect(evaluateTarget(t, ctx({ month: '2026-06', assigned: 20_000 }))).toMatchObject({
      need: 50_000,
      underfunded: 30_000,
    });
  });

  it('monthly set aside ignores what carried over', () => {
    const t = target({ amount: 50_000 });
    expect(evaluateTarget(t, ctx({ carry: 40_000, assigned: 20_000 }))).toMatchObject({ need: 50_000, underfunded: 30_000 });
  });

  it('monthly refill counts carried-over money', () => {
    const t = target({ amount: 50_000, mode: 'refill' });
    expect(evaluateTarget(t, ctx({ carry: 40_000, assigned: 0 }))).toMatchObject({ need: 50_000, underfunded: 10_000 });
    expect(evaluateTarget(t, ctx({ carry: 40_000, assigned: 10_000 }))?.underfunded).toBe(0);
  });

  it('weekly without a weekday throws', () => {
    const t = target({ cadence: 'weekly', amount: 10_000, dueWeekday: null });
    expect(() => evaluateTarget(t, ctx({}))).toThrow('A weekly target needs dueWeekday');
  });

  it('a spending target without a cadence throws', () => {
    const t = target({ cadence: 'none', amount: 10_000 });
    expect(() => evaluateTarget(t, ctx({}))).toThrow(
      'A spending target needs a weekly, monthly, yearly or custom cadence',
    );
  });
});

describe('spending targets: yearly and custom', () => {
  const yearly = target({ cadence: 'yearly', amount: 120_000, dueDate: '2026-12-15' });

  it('golden 10: spreads the amount over the months left until the due month', () => {
    expect(evaluateTarget(yearly, ctx({ month: '2026-01' }))?.need).toBe(10_000);
  });

  it('golden 10: set aside counts this cycle’s earlier assignments', () => {
    const assignedIn = (m: string) => (m === '2026-01' || m === '2026-02' ? 10_000 : 0);
    expect(evaluateTarget(yearly, ctx({ month: '2026-03', carry: 15_000, assignedIn }))?.need).toBe(10_000);
  });

  it('golden 10: refill counts what is available, so spending raises the need', () => {
    const refill = { ...yearly, mode: 'refill' as const };
    expect(evaluateTarget(refill, ctx({ month: '2026-03', carry: 15_000 }))?.need).toBe(10_500);
  });

  it('starts a new cycle after the due month when repeating', () => {
    const assignedIn = () => 10_000;
    expect(evaluateTarget(yearly, ctx({ month: '2027-01', assignedIn }))?.need).toBe(10_000);
  });

  it('custom: repeats every N months', () => {
    const quarterly = target({ cadence: 'custom', amount: 30_000, dueDate: '2026-03-10', repeatUnit: 'month', repeatEvery: 3 });
    expect(evaluateTarget(quarterly, ctx({ month: '2026-04' }))?.need).toBe(10_000);
  });

  it('custom without repeat: everything is due at once when overdue', () => {
    const once = target({ cadence: 'custom', amount: 50_000, dueDate: '2026-03-10', mode: 'refill' });
    expect(evaluateTarget(once, ctx({ month: '2026-05', carry: 30_000 }))?.need).toBe(20_000);
  });

  it.each([0, -1])('custom: rejects repeatEvery %i instead of looping forever', (repeatEvery) => {
    const t = target({ cadence: 'custom', amount: 30_000, dueDate: '2026-03-10', repeatUnit: 'month', repeatEvery });
    expect(() => evaluateTarget(t, ctx({ month: '2026-05' }))).toThrow(
      `Target repeatEvery must be an integer ≥ 1, got ${repeatEvery}`,
    );
  });
});

describe('balance targets', () => {
  it('without a date: underfunded is the gap to the target balance', () => {
    const t = target({ kind: 'balance', cadence: 'none', amount: 100_000, mode: null });
    expect(evaluateTarget(t, ctx({ carry: 30_000, assigned: 10_000, available: 40_000 }))).toMatchObject({
      need: 70_000,
      underfunded: 60_000,
      progress: 0.4,
    });
  });

  it('by date: spreads the remaining amount over the months left', () => {
    const t = target({ kind: 'balance', cadence: 'none', amount: 120_000, mode: null, dueDate: '2026-12-31' });
    expect(evaluateTarget(t, ctx({ month: '2026-01' }))?.need).toBe(10_000);
  });
});

describe('debt targets', () => {
  const debt = { minPayment: 20_000, apr: '12', balanceAtMonthStart: -1_200_000 };

  it('minimum payment', () => {
    const t = target({ kind: 'debt', cadence: 'none', mode: null, debtMode: 'min_payment' });
    expect(evaluateTarget(t, ctx({ assigned: 5_000, debt }))).toMatchObject({ need: 20_000, underfunded: 15_000 });
  });

  it('fixed amount', () => {
    const t = target({ kind: 'debt', cadence: 'none', mode: null, debtMode: 'fixed', amount: 30_000 });
    expect(evaluateTarget(t, ctx({ debt }))?.need).toBe(30_000);
  });

  it('pay off by date uses an amortized payment', () => {
    const t = target({ kind: 'debt', cadence: 'none', mode: null, debtMode: 'payoff_by_date', dueDate: '2026-12-01' });
    expect(evaluateTarget(t, ctx({ debt }))?.need).toBe(106_619);
  });

  it('pay off by date adds the loan escrow to the amortized payment', () => {
    const t = target({ kind: 'debt', cadence: 'none', mode: null, debtMode: 'payoff_by_date', dueDate: '2055-12-01' });
    const mortgage = { minPayment: 0, apr: '6', balanceAtMonthStart: -10_000_000, escrow: 20_000 };
    // 100 000 zł at 6 % due 2055-12 is 360 payments from 2026-01. amortizedPayment(10_000_000, '6', 360) = 59_956
    // (pinned in loans.test.ts), plus the 20_000 escrow = 79_956.
    expect(evaluateTarget(t, ctx({ month: '2026-01', debt: mortgage }))?.need).toBe(79_956);
  });

  it('pay off by date needs nothing when the account is in credit', () => {
    const t = target({ kind: 'debt', cadence: 'none', mode: null, debtMode: 'payoff_by_date', dueDate: '2026-12-01' });
    expect(evaluateTarget(t, ctx({ debt: { ...debt, balanceAtMonthStart: 50_000 } }))?.need).toBe(0);
  });

  it('requires debt context', () => {
    const t = target({ kind: 'debt', cadence: 'none', mode: null, debtMode: 'min_payment' });
    expect(() => evaluateTarget(t, ctx({}))).toThrow('debt');
  });

  it('requires a debt mode', () => {
    const t = target({ kind: 'debt', cadence: 'none', mode: null, debtMode: null, dueDate: '2026-12-01' });
    expect(() => evaluateTarget(t, ctx({ debt }))).toThrow('A debt target needs debtMode');
  });
});

describe('snooze, overfunding and inactive months', () => {
  it('snoozed targets are never underfunded', () => {
    const t = target({ amount: 50_000, snoozedMonth: '2026-01' });
    expect(evaluateTarget(t, ctx({}))).toMatchObject({ underfunded: 0, snoozed: true, progress: 0 });
  });

  it('flags assigning more than needed as overfunded', () => {
    expect(evaluateTarget(target({ amount: 50_000 }), ctx({ assigned: 60_000 }))?.overfunded).toBe(true);
  });

  it('returns null before the target start month', () => {
    expect(evaluateTarget(target({ startMonth: '2026-05' }), ctx({ month: '2026-04' }))).toBeNull();
  });
});

describe('pillColor', () => {
  const cm = { available: 0, cashOverspent: 0, creditOverspent: 0 };
  const met = { need: 100, underfunded: 0, progress: 1, overfunded: false, snoozed: false };

  it('is red for cash overspending, yellow for credit overspending or underfunded', () => {
    expect(pillColor({ ...cm, available: -5, cashOverspent: 3, creditOverspent: 2 }, null)).toBe('red');
    expect(pillColor({ ...cm, available: -5, creditOverspent: 5 }, null)).toBe('yellow');
    expect(pillColor({ ...cm, available: 50 }, { ...met, underfunded: 50 })).toBe('yellow');
  });

  it('is green with money available or a met target, grey otherwise', () => {
    expect(pillColor({ ...cm, available: 1 }, null)).toBe('green');
    expect(pillColor(cm, met)).toBe('green');
    expect(pillColor(cm, null)).toBe('grey');
  });
});
