import { addMonths } from '../../engine/dates';
import type { BudgetMonthDto } from '../../shared/api/budget';

export interface CategorySpending {
  id: string;
  name: string;
  /** Net outflow in the month, PLN minor units (> 0). */
  spent: number;
}

/**
 * What a month's categories spent (their net outflows), most first. Card payment categories are left out: their
 * activity moves money to the card, and the purchases already count in their own categories.
 */
export function spendingByCategory(view: BudgetMonthDto): CategorySpending[] {
  const categories = [...(view.uncategorized ? [view.uncategorized] : []), ...view.groups.flatMap((g) => g.categories)];
  return categories
    .filter((c) => c.kind !== 'cc_payment' && c.activity < 0)
    .map((c) => ({
      id: c.id,
      name: c.kind === 'uncategorized' ? 'Uncategorized Transactions' : c.name,
      spent: -c.activity,
    }))
    .sort((a, b) => b.spent - a.spent);
}

/** The breakdown's colours: the top five categories, then All Others. */
export const BREAKDOWN_COLORS = ['#575cf0', '#8bc34a', '#d4a937', '#b83f3f', '#4248c9', '#8a90f5'] as const;

export interface Slice extends CategorySpending {
  color: string;
}

export interface SpendingBreakdown {
  total: number;
  /** The top categories, and "All Others" for the rest. */
  slices: Slice[];
}

/** Reflect's Spending Breakdown: the month's total and its top `top` categories, the rest as "All Others". */
export function spendingBreakdown(view: BudgetMonthDto, top = 5): SpendingBreakdown {
  const all = spendingByCategory(view);
  const slices: Slice[] = all.slice(0, top).map((c, i) => ({ ...c, color: BREAKDOWN_COLORS[i]! }));
  const others = all.slice(top).reduce((sum, c) => sum + c.spent, 0);
  if (others > 0) slices.push({ id: 'others', name: 'All Others', spent: others, color: BREAKDOWN_COLORS[top]! });
  return { total: all.reduce((sum, c) => sum + c.spent, 0), slices };
}

export interface MonthTotals {
  month: string;
  /** Inflows to Ready to Assign. */
  income: number;
  spending: number;
}

export function monthTotals(view: BudgetMonthDto): MonthTotals {
  return { month: view.month, income: view.rta.income, spending: spendingBreakdown(view).total };
}

/** The months of Income vs. Spending: the `count` months up to `current`. */
export function chartMonths(current: string, count = 6): string[] {
  return Array.from({ length: count }, (_, i) => addMonths(current, i - count + 1));
}

/**
 * Income vs. Spending over `months`, from the month views there are (months before the budget's first month have
 * none and show as 0), and the sentence above the chart from the averages of the months with a view.
 */
export function incomeVsSpending(
  months: string[],
  views: BudgetMonthDto[],
): { totals: MonthTotals[]; summary: string | null } {
  const known = new Map(views.map((view) => [view.month, monthTotals(view)]));
  const totals = months.map((month) => known.get(month) ?? { month, income: 0, spending: 0 });
  if (known.size === 0) return { totals, summary: null };
  const income = [...known.values()].reduce((sum, m) => sum + m.income, 0);
  const spending = [...known.values()].reduce((sum, m) => sum + m.spending, 0);
  const summary =
    spending > income
      ? 'On average, you’re spending more than you make.'
      : 'On average, you’re making more than you spend.';
  return { totals, summary };
}
