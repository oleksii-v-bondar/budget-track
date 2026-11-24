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
  bad: 'text-red-400',
  warn: 'text-yellow-400',
  good: 'text-lime',
  muted: 'text-muted',
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

/** A budget row's progress bar and status line (YNAB's iOS app). */
export interface CategoryStatus {
  /** The line under the bar; null when there is nothing to say. */
  text: string | null;
  tone: CategoryHint['tone'];
  /** The bar's colour; `empty` shows only the track. */
  bar: 'lime' | 'yellow' | 'red' | 'empty';
  /** How much of the bar is filled, 0..1. */
  filled: number;
  /** How much of the filled part was spent (drawn darker), 0..1. */
  spent: number;
}

const fraction = (part: number, whole: number) => (whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0);

/**
 * A budget row's status from the month's numbers: what needs doing first (Uncategorized activity, overspending, an
 * unfinished or underfunded target, a card to pay), then how the money stands: "Funded", "Funded. Spent X of Y" or
 * "Fully Spent". The bar shows the funding, with the part already spent darker.
 */
export function categoryStatus(category: BudgetCategoryDto): CategoryStatus {
  const { available, activity, targetEvaluation: evaluation } = category;
  const spentSoFar = Math.max(0, -activity);
  // What the month had to spend: Available plus what is already gone.
  const funds = available + spentSoFar;
  const spent = fraction(spentSoFar, funds);
  const status = (text: string | null, tone: CategoryHint['tone'], bar: CategoryStatus['bar'], filled: number) => ({
    text,
    tone,
    bar,
    filled,
    spent: bar === 'lime' ? spent : 0,
  });

  if (category.kind === 'uncategorized') {
    return status(
      activity !== 0 ? 'Give these transactions a category' : null,
      'warn',
      available < 0 ? 'red' : 'empty',
      1,
    );
  }
  if (category.cashOverspent > 0) return status('Overspent', 'bad', 'red', 1);
  if (category.creditOverspent > 0) return status('Overspent on credit', 'warn', 'yellow', 1);
  if (evaluation && (evaluation.incomplete || evaluation.underfunded > 0)) {
    return status(categoryHint(category)!.text, 'warn', 'yellow', evaluation.progress);
  }
  if (category.needToPayInFull !== null && category.needToPayInFull > 0) {
    const need = category.needToPayInFull;
    return status(`Need ${formatMoney(need)} to pay in full`, 'muted', 'lime', fraction(available, available + need));
  }
  if (evaluation?.snoozed) return status('Target snoozed this month', 'muted', funds > 0 ? 'lime' : 'empty', 1);
  if (funds <= 0) {
    if (evaluation) return status(categoryHint(category)!.text, 'muted', 'empty', 0);
    return status(null, 'muted', 'empty', 0);
  }
  if (available <= 0) return status('Fully Spent', 'muted', 'lime', 1);
  if (spentSoFar > 0)
    return status(`Funded. Spent ${formatMoney(spentSoFar)} of ${formatMoney(funds)}`, 'muted', 'lime', 1);
  return status('Funded', 'muted', 'lime', 1);
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
