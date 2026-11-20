import type { ActivityRow, AssignmentRow, BudgetCategory, BudgetInput, CardTransferRow } from './types';

export const RTA = 'rta';

export function budgetInput(partial: Partial<BudgetInput>): BudgetInput {
  return {
    startMonth: '2026-01',
    throughMonth: '2026-01',
    rtaCategoryId: RTA,
    categories: [],
    assignments: [],
    activity: [],
    cardTransfers: [],
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

export function cardLine(month: string, categoryId: string, amount: number, accountId = 'visa'): ActivityRow {
  return { month, categoryId, accountId, accountClass: 'credit', amount };
}

export function cardPayment(cardAccountId: string): BudgetCategory {
  return { id: `pay-${cardAccountId}`, kind: 'cc_payment', linkedAccountId: cardAccountId };
}

export function cardTransfer(month: string, cardAccountId: string, amount: number): CardTransferRow {
  return { month, cardAccountId, amount };
}
