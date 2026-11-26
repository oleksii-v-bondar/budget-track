import { addMonths } from '../../engine/dates';
import type { BudgetCategoryDto, BudgetGroupDto, BudgetMonthDto, RtaBreakdownDto } from '../../shared/api/budget';
import type { TargetDto, TargetEvaluationDto } from '../../shared/api/targets';
import type { TransactionDto } from '../../shared/api/transactions';

/** Month view and register DTOs for web tests: every field has a neutral default, so a test states only what it is about. */

export function budgetCategory(
  fields: Partial<BudgetCategoryDto> & Pick<BudgetCategoryDto, 'id' | 'name'>,
): BudgetCategoryDto {
  return {
    kind: 'normal',
    hidden: false,
    note: null,
    linkedAccountId: null,
    carry: 0,
    assigned: 0,
    activity: 0,
    available: 0,
    cashOverspent: 0,
    creditOverspent: 0,
    pill: 'grey',
    target: null,
    targetEvaluation: null,
    needToPayInFull: null,
    loan: null,
    ...fields,
  };
}

export function budgetGroup(fields: Partial<BudgetGroupDto> & Pick<BudgetGroupDto, 'id' | 'name'>): BudgetGroupDto {
  return { kind: 'normal', hidden: false, categories: [], ...fields };
}

/** Ready to Assign with no history: everything left over. */
export function rtaBreakdown(readyToAssign: number, parts: Partial<RtaBreakdownDto> = {}): RtaBreakdownDto {
  return {
    leftoverPrev: 0,
    income: 0,
    assignedThisMonth: 0,
    assignedFuture: 0,
    cashOverspentPrev: 0,
    leftover: readyToAssign,
    readyToAssign,
    ...parts,
  };
}

/** A month the switcher can leave in both directions only if a test widens `firstMonth`. */
export function budgetMonth(fields: Partial<BudgetMonthDto> = {}): BudgetMonthDto {
  const month = fields.month ?? '2026-11';
  return {
    month,
    budgetStartMonth: month,
    firstMonth: month,
    currentMonth: month,
    lastMonth: addMonths(month, 24),
    note: null,
    rta: rtaBreakdown(0),
    groups: [],
    uncategorized: null,
    ...fields,
  };
}

/** The month of a `/api/budget/:month…` request path. */
export function monthOfPath(path: string): string {
  const match = /^\/api\/budget\/(\d{4}-\d{2})/.exec(path);
  if (!match) throw new Error(`not a budget path: ${path}`);
  return match[1]!;
}

/** A monthly spending target (set aside, due on the last day). */
export function monthlyTarget(categoryId: string, amount: number, fields: Partial<TargetDto> = {}): TargetDto {
  return {
    categoryId,
    kind: 'spending',
    cadence: 'monthly',
    amount,
    mode: 'set_aside',
    dueWeekday: null,
    dueDayOfMonth: null,
    dueDate: null,
    repeatUnit: null,
    repeatEvery: null,
    startMonth: '2026-09',
    debtMode: null,
    snoozedMonth: null,
    ...fields,
  };
}

export function evaluation(need: number, underfunded: number, fields: Partial<TargetEvaluationDto> = {}): TargetEvaluationDto {
  return {
    need,
    underfunded,
    progress: need === 0 ? 1 : (need - underfunded) / need,
    overfunded: false,
    snoozed: false,
    incomplete: false,
    ...fields,
  };
}

/**
 * November 2026 with a bit of everything: a funded and an underfunded target, cash and credit overspending, a card
 * payment category, hidden categories (one in a hidden group) and Uncategorized activity. Ready to Assign: 100 zł.
 */
export function sampleBudget(fields: Partial<BudgetMonthDto> = {}): BudgetMonthDto {
  return budgetMonth({
    firstMonth: '2026-09',
    rta: rtaBreakdown(10000, { income: 500000, assignedThisMonth: 490000, leftover: 10000 }),
    groups: [
      budgetGroup({
        id: 'g-bills',
        name: 'Bills',
        categories: [
          budgetCategory({
            id: 'c-rent',
            name: 'Rent',
            assigned: 200000,
            available: 200000,
            pill: 'green',
            target: monthlyTarget('c-rent', 200000),
            targetEvaluation: evaluation(200000, 0),
          }),
          budgetCategory({
            id: 'c-power',
            name: 'Electricity',
            assigned: 10000,
            available: 10000,
            pill: 'yellow',
            target: monthlyTarget('c-power', 25000),
            targetEvaluation: evaluation(25000, 15000),
          }),
        ],
      }),
      budgetGroup({
        id: 'g-everyday',
        name: 'Everyday',
        categories: [
          budgetCategory({
            id: 'c-groceries',
            name: 'Groceries',
            assigned: 50000,
            activity: -58000,
            available: -8000,
            cashOverspent: 8000,
            pill: 'red',
          }),
          budgetCategory({
            id: 'c-eating',
            name: 'Eating out',
            activity: -3000,
            available: -3000,
            creditOverspent: 3000,
            pill: 'yellow',
          }),
          budgetCategory({ id: 'c-fun', name: 'Fun money' }),
          budgetCategory({ id: 'c-gifts', name: 'Gifts', hidden: true, assigned: 5000, available: 5000, pill: 'green' }),
        ],
      }),
      budgetGroup({
        id: 'g-cards',
        name: 'Credit Card Payments',
        kind: 'cc_payments',
        categories: [
          budgetCategory({
            id: 'c-visa',
            name: 'Visa',
            kind: 'cc_payment',
            linkedAccountId: 'a-visa',
            activity: 3000,
            available: 3000,
            pill: 'green',
            needToPayInFull: 120000,
          }),
        ],
      }),
      budgetGroup({
        id: 'g-old',
        name: 'Old stuff',
        hidden: true,
        categories: [budgetCategory({ id: 'c-hobby', name: 'Old hobby' })],
      }),
    ],
    uncategorized: budgetCategory({
      id: 'c-uncategorized',
      name: 'Uncategorized',
      kind: 'uncategorized',
      activity: -2500,
      available: -2500,
      cashOverspent: 2500,
      pill: 'red',
    }),
    ...fields,
  });
}

/** A register row (PLN, uncleared, not a split or transfer unless the fields say so). */
export function transactionDto(fields: Partial<TransactionDto> & Pick<TransactionDto, 'id' | 'date' | 'amount'>): TransactionDto {
  return {
    accountId: 'a-checking',
    accountName: 'Checking',
    currency: 'PLN',
    payeeId: null,
    payeeName: null,
    categoryId: null,
    categoryName: null,
    memo: null,
    amountBase: fields.amount,
    fxRate: null,
    fxRateManual: false,
    effectiveRate: null,
    cleared: 'uncleared',
    approved: true,
    bankPending: false,
    flag: null,
    isStartingBalance: false,
    isSplit: false,
    transfer: null,
    lines: [],
    ...fields,
  };
}
