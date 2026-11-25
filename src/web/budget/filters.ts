import type { BudgetCategoryDto, BudgetGroupDto, BudgetMonthDto } from '../../shared/api/budget';
import { type HiddenCategory, splitHidden } from './view-model';

/** Spec §11's filters (and Overspent, which Home links to), in order. */
export const BUDGET_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'overspent', label: 'Overspent' },
  { value: 'underfunded', label: 'Underfunded' },
  { value: 'overfunded', label: 'Overfunded' },
  { value: 'available', label: 'Money available' },
  { value: 'snoozed', label: 'Snoozed' },
] as const;

export type BudgetFilter = (typeof BUDGET_FILTERS)[number]['value'];

/**
 * Available < 0; spec §6: underfunded > 0 (0 while snoozed), Assigned above the need, Available > 0, snoozed this
 * month.
 */
const MATCHES: Record<BudgetFilter, (category: BudgetCategoryDto) => boolean> = {
  all: () => true,
  overspent: (c) => c.available < 0,
  underfunded: (c) => (c.targetEvaluation?.underfunded ?? 0) > 0,
  overfunded: (c) => c.targetEvaluation?.overfunded === true,
  available: (c) => c.available > 0,
  snoozed: (c) => c.targetEvaluation?.snoozed === true,
};

export interface FilteredBudget {
  uncategorized: BudgetCategoryDto | null;
  groups: BudgetGroupDto[];
  /** Only under All. */
  hidden: HiddenCategory[];
}

/**
 * What the list shows under a filter. All lists every visible group (an empty one too) and the hidden section; the
 * other filters list the matching visible categories, in the groups that have one, and leave hidden ones out.
 */
export function filterBudget(view: BudgetMonthDto, filter: BudgetFilter): FilteredBudget {
  const { groups, hidden } = splitHidden(view);
  const matches = MATCHES[filter];
  const uncategorized = view.uncategorized && matches(view.uncategorized) ? view.uncategorized : null;
  if (filter === 'all') return { uncategorized, groups, hidden };
  return {
    uncategorized,
    groups: groups
      .map((group) => ({ ...group, categories: group.categories.filter(matches) }))
      .filter((group) => group.categories.length > 0),
    hidden: [],
  };
}

/** How many listed categories (Uncategorized included) each filter would show. */
export function filterCounts(view: BudgetMonthDto): Record<BudgetFilter, number> {
  const counts = {} as Record<BudgetFilter, number>;
  for (const { value } of BUDGET_FILTERS) {
    const { uncategorized, groups } = filterBudget(view, value);
    counts[value] = (uncategorized ? 1 : 0) + groups.reduce((sum, group) => sum + group.categories.length, 0);
  }
  return counts;
}

/** Shown when a filter matches nothing. */
export const EMPTY_FILTER_MESSAGES: Record<BudgetFilter, string> = {
  all: 'No categories yet. Tap Edit Plan to add a group and its categories.',
  overspent: 'No category is overspent.',
  underfunded: 'No target needs more money this month.',
  overfunded: 'No category has more assigned than its target needs.',
  available: 'No category has money available.',
  snoozed: 'No target is snoozed this month.',
};

/** The router's check of `?filter=`. */
export function isBudgetFilter(value: unknown): value is BudgetFilter {
  return BUDGET_FILTERS.some((filter) => filter.value === value);
}
