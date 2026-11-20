import type { BudgetResult, CategoryMonth } from './budget/types';
import { addMonths } from './dates';
import { assertMoney, roundDiv } from './money';
import type { Money, Month } from './types';

export type AutoAssignStrategy =
  | 'underfunded'
  | 'assigned_last_month'
  | 'spent_last_month'
  | 'average_assigned'
  | 'average_spent'
  | 'reset_available'
  | 'reset_assigned';

export interface AutoAssignArgs {
  strategy: AutoAssignStrategy;
  month: Month;
  /** Categories in scope, in display order. */
  categoryIds: string[];
  budget: BudgetResult;
  /** Underfunded amount per category for `month` (required for the "underfunded" strategy). */
  underfunded?: Record<string, Money>;
}

export interface AssignmentChange {
  categoryId: string;
  from: Money;
  to: Money;
}

const AVERAGE_WINDOW = 12;

function cell(budget: BudgetResult, month: Month, categoryId: string): Pick<CategoryMonth, 'assigned' | 'activity' | 'available'> {
  return budget.byMonth[month]?.categories[categoryId] ?? { assigned: 0, activity: 0, available: 0 };
}

/** Up to 12 months before `month` that exist in the computed budget. */
function previousMonths(budget: BudgetResult, month: Month): Month[] {
  const result: Month[] = [];
  for (let i = 1; i <= AVERAGE_WINDOW; i++) {
    const m = addMonths(month, -i);
    if (budget.byMonth[m]) result.push(m);
  }
  return result;
}

function average(values: Money[]): Money {
  if (values.length === 0) return 0;
  return Number(roundDiv(BigInt(values.reduce((s, v) => s + v, 0)), BigInt(values.length)));
}

/** Computes new assigned amounts for `month`; returns only categories whose amount changes. */
export function autoAssign(args: AutoAssignArgs): AssignmentChange[] {
  const { budget, month, strategy } = args;
  const last = addMonths(month, -1);
  const history = previousMonths(budget, month);
  let remaining = budget.byMonth[month]?.rta.readyToAssign ?? 0;
  if (strategy === 'underfunded' && !args.underfunded) throw new Error('The underfunded strategy needs underfunded amounts');
  for (const [categoryId, amount] of Object.entries(args.underfunded ?? {})) {
    assertMoney(amount, `underfunded.${categoryId}`);
  }

  const changes: AssignmentChange[] = [];
  for (const categoryId of args.categoryIds) {
    const current = cell(budget, month, categoryId);
    let to: Money;
    switch (strategy) {
      case 'underfunded': {
        const amount = Math.min(Math.max(0, args.underfunded?.[categoryId] ?? 0), Math.max(0, remaining));
        remaining -= amount;
        to = current.assigned + amount;
        break;
      }
      case 'assigned_last_month':
        to = cell(budget, last, categoryId).assigned;
        break;
      case 'spent_last_month':
        to = Math.max(0, -cell(budget, last, categoryId).activity);
        break;
      case 'average_assigned':
        to = average(history.map((m) => cell(budget, m, categoryId).assigned));
        break;
      case 'average_spent':
        to = Math.max(0, -average(history.map((m) => cell(budget, m, categoryId).activity)));
        break;
      case 'reset_available':
        to = current.assigned - current.available;
        break;
      case 'reset_assigned':
        to = 0;
        break;
    }
    if (to !== current.assigned) changes.push({ categoryId, from: current.assigned, to });
  }
  return changes;
}
