import { eq } from 'drizzle-orm';
import {
  addMonths,
  type BudgetResult,
  cardPaymentShortfall,
  computeBudget,
  type IsoDate,
  type Month,
  monthOf,
  pillColor,
} from '../../engine';
import type { BudgetCategoryDto, BudgetMonthDto } from '../../shared/api/budget';
import type { CategoryDto } from '../../shared/api/categories';
import { listCategoryGroups } from '../categories/category-queries';
import type { Executor } from '../db/client';
import { monthNote, target } from '../db/schema';
import { evaluateCategoryTarget, loadLinkedAccounts, toTargetDto } from '../targets/target-model';
import { assertBudgetMonth, budgetStartMonth, MONTHS_AHEAD, monthStart } from './assignments';
import { loadBudgetInput } from './budget-input';

export interface BudgetMonth {
  /** Every month from the budget start through `month`, plus later months with assignments. */
  result: BudgetResult;
  view: BudgetMonthDto;
}

/**
 * The Budget screen for `month` (spec §11) from one `computeBudget` run. Throws 422 `month_out_of_range` outside the
 * first editable month .. current month + 24. Callers run it in one transaction, so every query reads one snapshot.
 */
export async function loadBudgetMonth(db: Executor, month: Month, today: IsoDate): Promise<BudgetMonth> {
  await assertBudgetMonth(db, month, today);
  const input = await loadBudgetInput(db, { throughMonth: month, today });
  const result = computeBudget(input);
  const cells = result.byMonth[month]!;
  const groups = await listCategoryGroups(db);
  const targets = new Map((await db.select().from(target)).map((row) => [row.categoryId, toTargetDto(row)]));
  const linked = await loadLinkedAccounts(db, month, today);
  const [note] = await db
    .select({ note: monthNote.note })
    .from(monthNote)
    .where(eq(monthNote.month, monthStart(month)));

  const row = (c: CategoryDto): BudgetCategoryDto => {
    const cell = cells.categories[c.id]!;
    const def = targets.get(c.id) ?? null;
    const account = linked.get(c.id);
    const evaluation = def && evaluateCategoryTarget(def, result, month, c.id, account);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      hidden: c.hidden,
      note: c.note,
      linkedAccountId: c.linkedAccountId,
      carry: cell.carry,
      assigned: cell.assigned,
      activity: cell.activity,
      available: cell.available,
      cashOverspent: cell.cashOverspent,
      creditOverspent: cell.creditOverspent,
      pill: pillColor(cell, evaluation),
      target: def,
      targetEvaluation: evaluation,
      needToPayInFull:
        c.kind === 'cc_payment' && account ? cardPaymentShortfall(account.balanceAtMonthEnd, cell.available) : null,
    };
  };

  const internal = groups.find((g) => g.kind === 'internal');
  const uncategorized = internal?.categories.find((c) => c.kind === 'uncategorized');
  const uncategorizedRow = uncategorized && row(uncategorized);
  const currentMonth = monthOf(today);
  return {
    result,
    view: {
      month,
      budgetStartMonth: await budgetStartMonth(db),
      firstMonth: input.startMonth,
      currentMonth,
      lastMonth: addMonths(currentMonth, MONTHS_AHEAD),
      note: note?.note ?? null,
      rta: cells.rta,
      groups: groups
        .filter((g) => g.kind !== 'internal')
        .map((g) => ({ id: g.id, name: g.name, kind: g.kind, hidden: g.hidden, categories: g.categories.map(row) })),
      // Spec §3 shows Uncategorized only with activity; money carried into the month keeps it visible too.
      uncategorized:
        uncategorizedRow && (uncategorizedRow.activity !== 0 || uncategorizedRow.available !== 0)
          ? uncategorizedRow
          : null,
    },
  };
}
