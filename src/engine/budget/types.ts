import type { Money, Month } from '../types';

export interface BudgetCategory {
  id: string;
  kind: 'normal' | 'uncategorized' | 'cc_payment';
  /** For `cc_payment` categories: the credit account this category pays. */
  linkedAccountId?: string;
}

/**
 * Σ amount_base of ledger lines, grouped by month, category and account. What P2 must pass:
 * - on-budget lines only (cash and credit accounts; never tracking accounts)
 * - excluding transfer lines between two on-budget accounts (budget↔budget), and the starting-balance lines of
 *   credit and tracking accounts
 * - on-budget, non-transfer, non-starting-balance lines with a null category mapped to the Uncategorized category's id
 * - `month` formatted 'YYYY-MM'
 */
export interface ActivityRow {
  month: Month;
  /** Category id; the RTA category id marks income. */
  categoryId: string;
  accountId: string;
  accountClass: 'cash' | 'credit';
  amount: Money;
}

/**
 * Σ card-side amount_base of transfers between a credit account and any on-budget account (e.g. card payments and
 * card-to-card balance transfers), per month and card. These transfer lines are excluded from `ActivityRow`.
 * `month` is formatted 'YYYY-MM'.
 */
export interface CardTransferRow {
  month: Month;
  cardAccountId: string;
  amount: Money;
}

export interface AssignmentRow {
  month: Month;
  categoryId: string;
  amount: Money;
}

export interface BudgetInput {
  /** User-configured budget start; widened automatically to the earliest month with data. */
  startMonth: Month;
  /** Last month to compute; widened automatically to the latest month with data. */
  throughMonth: Month;
  /** Id of the system "Ready to Assign" category. Must not appear in `categories`. */
  rtaCategoryId: string;
  categories: BudgetCategory[];
  assignments: AssignmentRow[];
  activity: ActivityRow[];
  cardTransfers?: CardTransferRow[];
}

export interface CategoryMonth {
  categoryId: string;
  carry: Money;
  assigned: Money;
  activity: Money;
  available: Money;
  cashOverspent: Money;
  creditOverspent: Money;
  /** Credit overspending per credit account id (only non-zero entries). */
  creditOverByCard: Record<string, Money>;
}

export interface RtaBreakdown {
  leftoverPrev: Money;
  income: Money;
  assignedThisMonth: Money;
  assignedFuture: Money;
  cashOverspentPrev: Money;
  leftover: Money;
  readyToAssign: Money;
}

export interface MonthBudget {
  month: Month;
  rta: RtaBreakdown;
  /** Σ cashOverspent over all categories this month (deducted from next month's RTA). */
  cashOverspentTotal: Money;
  categories: Record<string, CategoryMonth>;
}

export interface BudgetResult {
  months: Month[];
  byMonth: Record<Month, MonthBudget>;
}
