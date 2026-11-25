import { countWeekdayInMonth, monthDiff, monthOf } from '../../engine/dates';
import { ceilDiv } from '../../engine/money';
import type { BudgetCategoryDto, BudgetMonthDto } from '../../shared/api/budget';
import type { TargetDto } from '../../shared/api/targets';
import { formatDate, formatMoney } from '../lib/format';

/** Months between a repeating target's due dates (yearly: 12), or null for a one-off. */
function cycleMonths(target: TargetDto): number | null {
  if (target.cadence === 'yearly') return 12;
  if (target.cadence !== 'custom' || !target.repeatUnit || !target.repeatEvery) return null;
  return target.repeatEvery * (target.repeatUnit === 'year' ? 12 : 1);
}

/**
 * A target due by a date: the month's need when the budget has evaluated it, else the amount spread over the months
 * from `month` (or the target's start) to the due month, as the engine does.
 */
function byDate(target: TargetDto, category: BudgetCategoryDto, month: string): number {
  if (category.targetEvaluation) return category.targetEvaluation.need;
  const from = target.startMonth > month ? target.startMonth : month;
  return ceilDiv(target.amount, Math.max(1, monthDiff(from, monthOf(target.dueDate!)) + 1));
}

/**
 * What a category's target costs a month (the Edit Plan's "Cost to Be Me"), in `month` ('YYYY-MM'); null without a
 * target. Monthly: the amount. Weekly: the amount times its weekday's occurrences in the month. Yearly and repeating
 * every N months or years: an even share of the cycle, rounded. By a date (one-off, or a balance by a date): what is
 * still needed this month. Debt: the minimum payment (the month's need) or the fixed amount. A balance to keep with
 * no date costs nothing a month.
 */
export function monthlyTargetAmount(category: BudgetCategoryDto, month: string): number | null {
  const target = category.target;
  if (!target) return null;
  if (target.kind === 'debt') {
    return target.debtMode === 'fixed' ? target.amount : (category.targetEvaluation?.need ?? 0);
  }
  if (target.kind === 'balance') return target.dueDate ? byDate(target, category, month) : 0;
  if (target.cadence === 'weekly') return target.amount * countWeekdayInMonth(month, target.dueWeekday ?? 0);
  if (target.cadence === 'monthly') return target.amount;
  const cycle = cycleMonths(target);
  return cycle === null ? byDate(target, category, month) : Math.round(target.amount / cycle);
}

/** Spec "Cost to Be Me": the monthly cost of every live category's target (hidden ones too) in the view's month. */
export function costToBeMe(view: BudgetMonthDto): number {
  return view.groups
    .flatMap((group) => group.categories)
    .reduce((sum, category) => sum + (monthlyTargetAmount(category, view.month) ?? 0), 0);
}

const every = (n: number, unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);

/**
 * The Edit Plan row's second line: the target as set, e.g. "350,00 zł Weekly". Null for monthly targets, whose
 * amount is already the row's.
 */
export function targetCadenceLabel(target: TargetDto): string | null {
  const money = formatMoney(target.amount);
  const due = target.dueDate && formatDate(target.dueDate);
  if (target.kind === 'debt') {
    if (target.debtMode === 'min_payment') return 'Minimum payment';
    return target.debtMode === 'payoff_by_date' ? `Pay off by ${due}` : null;
  }
  if (target.kind === 'balance') return due ? `${money} By ${due}` : `Have ${money}`;
  if (target.cadence === 'weekly') return `${money} Weekly`;
  if (target.cadence === 'yearly') return `${money} Yearly`;
  if (target.cadence === 'custom') {
    if (target.repeatUnit && target.repeatEvery) return `${money} ${every(target.repeatEvery, target.repeatUnit)}`;
    return `${money} By ${due}`;
  }
  return null;
}
