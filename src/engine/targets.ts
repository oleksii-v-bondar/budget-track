import { addMonths, countWeekdayInMonth, monthDiff, monthOf, monthRange } from './dates';
import { amortizedPayment } from './loans';
import { ceilDiv } from './money';
import type { IsoDate, Money, Month } from './types';

export interface TargetDef {
  kind: 'spending' | 'balance' | 'debt';
  cadence: 'weekly' | 'monthly' | 'yearly' | 'custom' | 'none';
  amount: Money;
  /** Spending targets: "set aside another X" or "refill up to X". */
  mode: 'set_aside' | 'refill' | null;
  /** 0 = Sunday … 6 = Saturday. */
  dueWeekday: number | null;
  /** Display only; null = last day of month. */
  dueDayOfMonth: number | null;
  dueDate: IsoDate | null;
  repeatUnit: 'month' | 'year' | null;
  repeatEvery: number | null;
  startMonth: Month;
  debtMode: 'min_payment' | 'fixed' | 'payoff_by_date' | null;
  snoozedMonth: Month | null;
}

export interface TargetContext {
  month: Month;
  carry: Money;
  assigned: Money;
  available: Money;
  /** Assigned amount of this category in another month (used for set-aside cycles). */
  assignedIn: (month: Month) => Money;
  /** Linked credit/loan account data; required for debt targets. `escrow` (loans only) defaults to 0. */
  debt?: { minPayment: Money; apr: string; balanceAtMonthStart: Money; escrow?: Money };
}

export interface TargetEval {
  need: Money;
  underfunded: Money;
  /** 0..1 */
  progress: number;
  overfunded: boolean;
  snoozed: boolean;
}

export type PillColor = 'red' | 'yellow' | 'green' | 'grey';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Months from `month` to `dueMonth` inclusive, at least 1 (overdue targets are due now). */
function monthsLeft(month: Month, dueMonth: Month): number {
  return Math.max(1, monthDiff(month, dueMonth) + 1);
}

function requireDueDate(t: TargetDef): IsoDate {
  if (!t.dueDate) throw new Error(`A ${t.kind}/${t.cadence} target needs a due date`);
  return t.dueDate;
}

/** Months between due dates, or null when the target doesn't repeat. */
function repeatStep(t: TargetDef): number | null {
  if (t.cadence === 'yearly') return 12;
  if (!t.repeatUnit) return null;
  const every = t.repeatEvery ?? 1;
  if (!Number.isInteger(every) || every < 1) {
    throw new Error(`Target repeatEvery must be an integer ≥ 1, got ${every}`);
  }
  return every * (t.repeatUnit === 'year' ? 12 : 1);
}

/** The due month that applies to `month` and the first month of its funding cycle. */
function dueCycle(t: TargetDef, month: Month): { dueMonth: Month; cycleStart: Month } {
  const firstDue = monthOf(requireDueDate(t));
  const step = repeatStep(t);
  if (step === null) return { dueMonth: firstDue, cycleStart: t.startMonth };
  let dueMonth = firstDue;
  let previousDue: Month | null = null;
  while (dueMonth < month) {
    previousDue = dueMonth;
    dueMonth = addMonths(dueMonth, step);
  }
  const afterPrevious = previousDue ? addMonths(previousDue, 1) : t.startMonth;
  return { dueMonth, cycleStart: afterPrevious > t.startMonth ? afterPrevious : t.startMonth };
}

function computeNeed(t: TargetDef, ctx: TargetContext): Money {
  if (t.kind === 'spending') {
    if (t.cadence === 'weekly') {
      if (t.dueWeekday === null) throw new Error('A weekly target needs dueWeekday');
      return t.amount * countWeekdayInMonth(ctx.month, t.dueWeekday);
    }
    if (t.cadence === 'monthly') return t.amount;
    if (t.cadence === 'none') {
      throw new Error('A spending target needs a weekly, monthly, yearly or custom cadence');
    }
    const { dueMonth, cycleStart } = dueCycle(t, ctx.month);
    const fundedBefore =
      t.mode === 'refill'
        ? ctx.carry
        : monthRange(cycleStart, addMonths(ctx.month, -1)).reduce((s, m) => s + ctx.assignedIn(m), 0);
    return ceilDiv(Math.max(0, t.amount - fundedBefore), monthsLeft(ctx.month, dueMonth));
  }
  if (t.kind === 'balance') {
    const remaining = Math.max(0, t.amount - ctx.carry);
    return t.dueDate ? ceilDiv(remaining, monthsLeft(ctx.month, monthOf(t.dueDate))) : remaining;
  }
  if (t.debtMode === null) throw new Error('A debt target needs debtMode');
  if (!ctx.debt) throw new Error('Debt targets need debt context (linked account data)');
  if (t.debtMode === 'min_payment') return ctx.debt.minPayment;
  if (t.debtMode === 'fixed') return t.amount;
  const payment = amortizedPayment(
    Math.max(0, -ctx.debt.balanceAtMonthStart),
    ctx.debt.apr,
    monthsLeft(ctx.month, monthOf(requireDueDate(t))),
  );
  return payment + (ctx.debt.escrow ?? 0);
}

/** Evaluates a category's target for `ctx.month`; null when the target hasn't started yet. */
export function evaluateTarget(t: TargetDef, ctx: TargetContext): TargetEval | null {
  if (ctx.month < t.startMonth) return null;
  const need = computeNeed(t, ctx);
  let underfunded: Money;
  if (t.kind === 'balance' && !t.dueDate) {
    underfunded = Math.max(0, t.amount - ctx.available);
  } else if (t.kind === 'spending' && t.mode === 'refill' && (t.cadence === 'weekly' || t.cadence === 'monthly')) {
    underfunded = Math.max(0, need - ctx.carry - ctx.assigned);
  } else {
    underfunded = Math.max(0, need - ctx.assigned);
  }
  const progress =
    t.kind === 'balance'
      ? t.amount === 0
        ? 1
        : clamp01(ctx.available / t.amount)
      : need === 0
        ? 1
        : clamp01((need - underfunded) / need);
  const snoozed = t.snoozedMonth === ctx.month;
  return {
    need,
    underfunded: snoozed ? 0 : underfunded,
    progress,
    overfunded: ctx.assigned > need,
    snoozed,
  };
}

/** Color of a category's Available pill (spec §6). */
export function pillColor(
  cm: { available: Money; cashOverspent: Money; creditOverspent: Money },
  target: TargetEval | null,
): PillColor {
  if (cm.cashOverspent > 0) return 'red';
  if (cm.creditOverspent > 0 || (target !== null && target.underfunded > 0)) return 'yellow';
  const targetMet = target !== null && !target.snoozed && target.need > 0 && target.underfunded === 0;
  if (cm.available > 0 || targetMet) return 'green';
  return 'grey';
}
