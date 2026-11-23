import type { BudgetCategoryDto, BudgetGroupDto, BudgetMonthDto } from '../../shared/api/budget';
import { formatMoney } from '../lib/format';

export type RtaTone = 'green' | 'red' | 'grey';

/** Spec §11: the Ready to Assign banner is green above 0, red below and grey at 0. */
export function rtaTone(readyToAssign: number): RtaTone {
  if (readyToAssign > 0) return 'green';
  return readyToAssign < 0 ? 'red' : 'grey';
}

export interface CategoryHint {
  text: string;
  tone: 'bad' | 'warn' | 'good' | 'muted';
}

/** Text colours of the hint tones. */
export const HINT_TONES: Record<CategoryHint['tone'], string> = {
  bad: 'text-red-700',
  warn: 'text-yellow-800',
  good: 'text-green-700',
  muted: 'text-gray-500',
};

/**
 * The line under a category's name: what needs doing first (Uncategorized activity, overspending, then the target),
 * else how the target stands, else a card's "Need X to pay in full" (unless `cardNeed: false`, for the category
 * sheet, which always shows it). Null when there is nothing to say.
 */
export function categoryHint(category: BudgetCategoryDto, { cardNeed = true } = {}): CategoryHint | null {
  // Money can't be moved to Uncategorized (spec §3): its transactions need categories instead.
  if (category.kind === 'uncategorized' && category.activity !== 0) {
    return { text: 'Give these transactions a category', tone: 'warn' };
  }
  if (category.cashOverspent > 0) return { text: 'Overspent: move money to cover it', tone: 'bad' };
  if (category.creditOverspent > 0) return { text: 'Overspent on credit', tone: 'warn' };
  const evaluation = category.targetEvaluation;
  if (evaluation) {
    if (evaluation.snoozed) return { text: 'Target snoozed this month', tone: 'muted' };
    if (evaluation.incomplete) {
      const missing = category.target?.debtMode === 'payoff_by_date' ? 'APR' : 'minimum payment';
      return { text: `Add the account's ${missing} to finish this target`, tone: 'warn' };
    }
    if (evaluation.underfunded > 0) {
      return { text: `${formatMoney(evaluation.underfunded)} more needed this month`, tone: 'warn' };
    }
    if (evaluation.overfunded) return { text: 'Funded, with more than the target needs', tone: 'good' };
    if (evaluation.need > 0) return { text: 'Funded', tone: 'good' };
    return { text: evaluation.progress >= 1 ? 'Target reached' : 'Nothing needed this month', tone: 'muted' };
  }
  if (cardNeed && category.needToPayInFull !== null && category.needToPayInFull > 0) {
    return { text: `Need ${formatMoney(category.needToPayInFull)} to pay in full`, tone: 'muted' };
  }
  return null;
}

/** The category with this id in the month view (Uncategorized included), or null once it is gone. */
export function findCategory(view: BudgetMonthDto, id: string): BudgetCategoryDto | null {
  if (view.uncategorized?.id === id) return view.uncategorized;
  for (const group of view.groups) {
    const found = group.categories.find((category) => category.id === id);
    if (found) return found;
  }
  return null;
}

/** A hidden category, listed with its group at the bottom of the budget. */
export interface HiddenCategory {
  category: BudgetCategoryDto;
  groupName: string;
}

/**
 * Splits the month view into what the budget lists (visible categories of visible groups; an empty group only if it
 * is the user's own, not the app's empty Credit Card or Debt Payments group) and the "Hidden categories" section
 * (hidden categories, and every category of a hidden group).
 */
export function splitHidden(view: BudgetMonthDto): { groups: BudgetGroupDto[]; hidden: HiddenCategory[] } {
  const groups: BudgetGroupDto[] = [];
  const hidden: HiddenCategory[] = [];
  for (const group of view.groups) {
    for (const category of group.categories) {
      if (group.hidden || category.hidden) hidden.push({ category, groupName: group.name });
    }
    if (group.hidden || (group.kind !== 'normal' && group.categories.length === 0)) continue;
    groups.push({ ...group, categories: group.categories.filter((c) => !c.hidden) });
  }
  return { groups, hidden };
}

/** The total Available of a group's listed categories, shown in its header. */
export function totalAvailable(categories: readonly BudgetCategoryDto[]): number {
  return categories.reduce((sum, category) => sum + category.available, 0);
}
