import { and, eq, isNull } from 'drizzle-orm';
import { type AssignmentChange, type AutoAssignStrategy, autoAssign, type IsoDate, type Month } from '../../engine';
import type { AutoAssignRequest, BudgetCategoryDto, BudgetMonthDto } from '../../shared/api/budget';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { categoryGroup } from '../db/schema';
import { DomainError } from '../http/errors';
import { assignableCategory, setAssigned } from './assignments';
import { loadBudgetMonth } from './budget-month';

type Scope = AutoAssignRequest['scope'];

/** Undo labels: "Auto-assign: Underfunded". */
export const STRATEGY_LABELS: Record<AutoAssignStrategy, string> = {
  underfunded: 'Underfunded',
  assigned_last_month: 'Assigned last month',
  spent_last_month: 'Spent last month',
  average_assigned: 'Average assigned',
  average_spent: 'Average spent',
  reset_available: 'Reset available',
  reset_assigned: 'Reset assigned',
};

/**
 * Like the assignment routes, reports an unusable scope before the month range: an unknown category is a 404,
 * Ready to Assign and Uncategorized are 422 `category_not_assignable`, an unknown or internal group is 422.
 */
async function assertScope(db: Executor, scope: Scope): Promise<void> {
  if (scope.type === 'category') await assignableCategory(db, scope.id);
  if (scope.type === 'group') {
    const [group] = await db
      .select({ kind: categoryGroup.kind })
      .from(categoryGroup)
      .where(and(eq(categoryGroup.id, scope.id), isNull(categoryGroup.deletedAt)));
    if (!group || group.kind === 'internal') {
      throw new DomainError('invalid_group', 'Choose one of your category groups.');
    }
  }
}

/**
 * The categories in scope, in display order (spec §7). The month view leaves out the internal group, so Ready to
 * Assign and Uncategorized are never in scope (`computeBudget` refuses assignments to Uncategorized).
 */
function categoriesInScope(view: BudgetMonthDto, scope: Scope): BudgetCategoryDto[] {
  if (scope.type === 'all') {
    return view.groups.filter((g) => !g.hidden).flatMap((g) => g.categories.filter((c) => !c.hidden));
  }
  if (scope.type === 'group') return view.groups.find((g) => g.id === scope.id)?.categories ?? [];
  return view.groups.flatMap((g) => g.categories).filter((c) => c.id === scope.id);
}

/** Spec §7: one undoable command that sets Assigned for every category in scope that the strategy changes. */
export async function autoAssignMonth(
  rec: ChangeRecorder,
  month: Month,
  request: AutoAssignRequest,
  today: IsoDate,
): Promise<AssignmentChange[]> {
  await assertScope(rec.tx, request.scope);
  const { result, view } = await loadBudgetMonth(rec.tx, month, today);
  const categories = categoriesInScope(view, request.scope);
  const changes = autoAssign({
    strategy: request.strategy,
    month,
    categoryIds: categories.map((c) => c.id),
    budget: result,
    // Snoozed targets and categories without a target are not underfunded. A huge target can be underfunded beyond
    // the safe-integer range; clamping is harmless because the engine caps every amount at Ready to Assign.
    underfunded:
      request.strategy === 'underfunded'
        ? Object.fromEntries(
            categories.map((c) => [c.id, Math.min(c.targetEvaluation?.underfunded ?? 0, Number.MAX_SAFE_INTEGER)]),
          )
        : undefined,
  });
  for (const change of changes) await setAssigned(rec, change.categoryId, month, change.to);
  return changes;
}
