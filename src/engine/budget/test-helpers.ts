import type { ActivityRow, AssignmentRow, BudgetCategory, BudgetInput } from './types';

export const RTA = 'rta';

export function budgetInput(partial: Partial<BudgetInput>): BudgetInput {
  return {
    startMonth: '2026-01',
    throughMonth: '2026-01',
    rtaCategoryId: RTA,
    categories: [],
    assignments: [],
    activity: [],
    ...partial,
  };
}

export function category(id: string, kind: BudgetCategory['kind'] = 'normal'): BudgetCategory {
  return { id, kind };
}

export function cashLine(month: string, categoryId: string, amount: number, accountId = 'checking'): ActivityRow {
  return { month, categoryId, accountId, accountClass: 'cash', amount };
}

export function assign(month: string, categoryId: string, amount: number): AssignmentRow {
  return { month, categoryId, amount };
}
