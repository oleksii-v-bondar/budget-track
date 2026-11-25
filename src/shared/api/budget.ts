import { z } from 'zod';
import type { CategoryGroupKind, CategoryKind } from './categories';
import { boundedMoneySchema, idSchema, moneySchema, monthSchema, noteSchema, positiveMoneySchema } from './common';
import type { TargetDto, TargetEvaluationDto } from './targets';

export const monthParamSchema = z.object({ month: monthSchema });
export const assignmentParamSchema = z.object({ month: monthSchema, categoryId: idSchema });

/** PUT /api/budget/:month/assignments/:categoryId — the category's new Assigned amount (0 clears it). */
export const setAssignmentRequestSchema = z.object({ amount: moneySchema });

/** POST /api/budget/:month/move — null stands for Ready to Assign (spec §3). */
export const moveMoneyRequestSchema = z
  .object({ from: idSchema.nullable(), to: idSchema.nullable(), amount: positiveMoneySchema })
  .refine((body) => body.from !== body.to, {
    path: ['to'],
    message: 'Choose two different places to move money between.',
  });

/** PUT /api/budget/:month/note — an empty note deletes it. */
export const monthNoteRequestSchema = z.object({ note: noteSchema });

export type MoveMoneyRequest = z.infer<typeof moveMoneyRequestSchema>;

/** PUT /api/budget/settings — the income the owner expects a month (the Edit Plan's yardstick); null unsets it. */
export const budgetSettingsRequestSchema = z.object({
  expectedMonthlyIncome: boundedMoneySchema.min(0, 'Enter 0 or more.').nullable(),
});

/** GET and PUT /api/budget/settings. */
export type BudgetSettingsDto = z.infer<typeof budgetSettingsRequestSchema>;

/** Spec §7 auto-assign strategies. */
export const AUTO_ASSIGN_STRATEGIES = [
  'underfunded',
  'assigned_last_month',
  'spent_last_month',
  'average_assigned',
  'average_spent',
  'reset_available',
  'reset_assigned',
] as const;

/**
 * POST /api/budget/:month/auto-assign. `all` covers the visible categories of visible groups; a group or a category
 * may be hidden. Ready to Assign and Uncategorized are never in scope.
 */
export const autoAssignRequestSchema = z.object({
  strategy: z.enum(AUTO_ASSIGN_STRATEGIES),
  scope: z.discriminatedUnion('type', [
    z.object({ type: z.literal('all') }),
    z.object({ type: z.literal('group'), id: idSchema }),
    z.object({ type: z.literal('category'), id: idSchema }),
  ]),
});

export type AutoAssignRequest = z.infer<typeof autoAssignRequestSchema>;

export interface AssignmentDto {
  /** 'YYYY-MM' */
  month: string;
  categoryId: string;
  /** Assigned in minor units (0 = no assignment). */
  amount: number;
}

export interface MoveMoneyResponse {
  /** The categories whose Assigned changed (one or two). */
  assignments: AssignmentDto[];
}

export interface AutoAssignResponse {
  /** The categories whose Assigned changed, with their new amounts (empty when nothing changed). */
  assignments: AssignmentDto[];
}

export interface MonthNoteDto {
  month: string;
  note: string | null;
}

/** Spec §6: the color of a category's Available pill. */
export type PillColor = 'red' | 'yellow' | 'green' | 'grey';

/** Spec §5.4: how Ready to Assign comes about in a month. */
export interface RtaBreakdownDto {
  /** Leftover of the previous month (negative leftovers carry forward). */
  leftoverPrev: number;
  income: number;
  assignedThisMonth: number;
  assignedFuture: number;
  cashOverspentPrev: number;
  /** leftoverPrev + income − assignedThisMonth − cashOverspentPrev */
  leftover: number;
  /** The banner amount: leftover − assignedFuture. */
  readyToAssign: number;
}

/** One budget row (spec §5, §6, §11); amounts are PLN minor units. */
export interface BudgetCategoryDto {
  id: string;
  name: string;
  /** `uncategorized` only for the Uncategorized row; Ready to Assign never appears. */
  kind: CategoryKind;
  hidden: boolean;
  note: string | null;
  /** The account of a credit card payment or paired loan category. */
  linkedAccountId: string | null;
  carry: number;
  assigned: number;
  activity: number;
  available: number;
  cashOverspent: number;
  creditOverspent: number;
  pill: PillColor;
  target: TargetDto | null;
  /** Null without a target, or before the target's start month. */
  targetEvaluation: TargetEvaluationDto | null;
  /** Credit card payment categories: "Need X to pay in full" (spec §5.3); null for every other category. */
  needToPayInFull: number | null;
  /** Paired loan categories: the loan panel (spec §8); null for every other category. */
  loan: LoanPanelDto | null;
}

export interface BudgetGroupDto {
  id: string;
  name: string;
  kind: CategoryGroupKind;
  hidden: boolean;
  /** Live categories in display order, hidden ones included (the UI lists them under "Hidden categories"). */
  categories: BudgetCategoryDto[];
}

/** GET /api/budget/:month — everything the Budget screen shows for one month (spec §11). */
export interface BudgetMonthDto {
  month: string;
  /** Spec §5.1: the earlier of the configured start month and the month of the earliest transaction. */
  budgetStartMonth: string;
  /**
   * The month switcher's lower bound: the budget start, or an earlier month that still holds an assignment or a note
   * (left behind when the budget start moved later).
   */
  firstMonth: string;
  /** Today's month in the budget's time zone. */
  currentMonth: string;
  /** The month switcher's upper bound: the current month + 24. */
  lastMonth: string;
  note: string | null;
  rta: RtaBreakdownDto;
  /** Every live group except the internal one, in display order. */
  groups: BudgetGroupDto[];
  /** Spec §3: present only while Uncategorized has activity or money in this month. */
  uncategorized: BudgetCategoryDto | null;
}

/** The loan panel of a paired loan category's sheet (spec §8, §11). */
export interface LoanPanelDto {
  accountId: string;
  accountName: string;
  currency: string;
  /** Today's balance with the interest and escrow charged (negative while owed), in the loan's currency. */
  balance: number;
  /** The same in PLN. */
  balanceBase: number;
  /** APR in percent, e.g. "6.0000". */
  interestRate: string | null;
  /** In the loan's currency. */
  minPayment: number | null;
  escrowAmount: number | null;
  /**
   * 'YYYY-MM' of the last payment at the debt target's monthly amount (the minimum payment without a fixed or
   * pay-off-by-date target), from the first month without a payment yet; 'never' when it can't pay the loan off
   * within 1200 months.
   */
  projectedPayoff: string;
  /** "Record payment" pre-fills the transaction sheet with this transfer to the loan. */
  recordPayment: {
    /** The cash account of the latest payment, else the first open cash account; null without one. */
    accountId: string | null;
    /** The loan's transfer payee. */
    payeeId: string;
    /** This paired category. */
    categoryId: string;
    /** −(the target's need this month), in PLN minor units; 0 without a target. */
    amount: number;
  };
}
