import { and, asc, eq, inArray, isNotNull, isNull, lte, not, or, sql } from 'drizzle-orm';
import { type BudgetCategory, type BudgetInput, type IsoDate, type Month, monthOf } from '../../engine';
import { categoryKindOf } from '../categories/category-queries';
import type { Executor } from '../db/client';
import { account, assignment, category, categoryGroup, ledgerLine } from '../db/schema';
import { firstEditableMonth } from './assignments';

/** A transfer between two on-budget accounts (cash or credit): budget-neutral, so never activity (spec §5.5). */
const isBudgetTransfer = sql`(${ledgerLine.isTransfer} and ${ledgerLine.counterAccountClass} in ('cash', 'credit'))`;

const total = sql<number>`sum(${ledgerLine.amountBase})::bigint`;

interface BudgetCategories {
  rtaCategoryId: string;
  uncategorizedId: string;
  categories: BudgetCategory[];
}

/** Every live category except Ready to Assign, which the engine takes separately. */
async function budgetCategories(db: Executor): Promise<BudgetCategories> {
  const rows = await db
    .select({
      id: category.id,
      systemKind: category.systemKind,
      linkedAccountId: category.linkedAccountId,
      groupKind: categoryGroup.kind,
    })
    .from(category)
    .innerJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
    .where(isNull(category.deletedAt))
    .orderBy(asc(category.id));
  let rtaCategoryId: string | undefined;
  let uncategorizedId: string | undefined;
  const categories: BudgetCategory[] = [];
  for (const row of rows) {
    const kind = categoryKindOf(row, row.groupKind);
    if (kind === 'rta') {
      rtaCategoryId = row.id;
    } else if (kind === 'uncategorized') {
      uncategorizedId = row.id;
      categories.push({ id: row.id, kind: 'uncategorized' });
    } else if (kind === 'cc_payment') {
      categories.push({ id: row.id, kind: 'cc_payment', linkedAccountId: row.linkedAccountId! });
    } else {
      // Paired loan categories are regular categories to the engine.
      categories.push({ id: row.id, kind: 'normal' });
    }
  }
  if (!rtaCategoryId || !uncategorizedId) throw new Error('The system categories are missing');
  return { rtaCategoryId, uncategorizedId, categories };
}

/**
 * The engine input for every month from the first editable month (the budget start, or an earlier month that still
 * holds an assignment or a note) through `throughMonth` (spec §2 "Read path"). Built from SQL aggregates over
 * `v_ledger_line` as `src/engine/budget/types.ts` documents. Only lines dated `today` or earlier count (spec §5.6);
 * months are 'YYYY-MM-01' in the database and 'YYYY-MM' in the engine.
 */
export async function loadBudgetInput(
  db: Executor,
  { throughMonth, today }: { throughMonth: Month; today: IsoDate },
): Promise<BudgetInput> {
  const { rtaCategoryId, uncategorizedId, categories } = await budgetCategories(db);
  const booked = and(inArray(ledgerLine.accountClass, ['cash', 'credit']), lte(ledgerLine.date, today));

  const activity = await db
    .select({
      month: ledgerLine.month,
      categoryId: ledgerLine.categoryId,
      accountId: ledgerLine.accountId,
      accountClass: ledgerLine.accountClass,
      amount: total,
    })
    .from(ledgerLine)
    .innerJoin(account, eq(account.id, ledgerLine.accountId))
    .where(
      and(
        booked,
        or(
          // Categorized lines, split lines and categorized transfers to tracking accounts (spec §5.1); credit
          // starting balances stay off the budget (spec §5.3).
          and(
            isNotNull(ledgerLine.categoryId),
            not(isBudgetTransfer),
            not(and(ledgerLine.isStartingBalance, eq(ledgerLine.accountClass, 'credit'))!),
          ),
          // Spec §3: on-budget, non-transfer, non-starting-balance lines without a category are Uncategorized.
          and(isNull(ledgerLine.categoryId), not(ledgerLine.isTransfer), not(ledgerLine.isStartingBalance)),
        ),
      ),
    )
    .groupBy(
      ledgerLine.month,
      ledgerLine.categoryId,
      ledgerLine.accountId,
      ledgerLine.accountClass,
      account.sortOrder,
    )
    // The engine splits credit overspending ties in input order, so cards come in display order.
    .orderBy(ledgerLine.month, ledgerLine.categoryId, account.sortOrder, ledgerLine.accountId);

  // Card payments, cash advances and balance transfers: the card side of transfers with on-budget accounts (§5.3).
  const cardTransfers = await db
    .select({ month: ledgerLine.month, cardAccountId: ledgerLine.accountId, amount: total })
    .from(ledgerLine)
    .where(and(booked, eq(ledgerLine.accountClass, 'credit'), isBudgetTransfer))
    .groupBy(ledgerLine.month, ledgerLine.accountId)
    .orderBy(ledgerLine.month, ledgerLine.accountId);

  const assignments = await db
    .select({ month: assignment.month, categoryId: assignment.categoryId, amount: assignment.amount })
    .from(assignment)
    .orderBy(assignment.month, assignment.categoryId);

  return {
    startMonth: await firstEditableMonth(db),
    throughMonth,
    rtaCategoryId,
    categories,
    assignments: assignments.map((a) => ({ ...a, month: monthOf(a.month) })),
    activity: activity.map((row) => ({
      month: monthOf(row.month),
      categoryId: row.categoryId ?? uncategorizedId,
      accountId: row.accountId,
      // The WHERE clause keeps on-budget accounts only.
      accountClass: row.accountClass as 'cash' | 'credit',
      amount: row.amount,
    })),
    cardTransfers: cardTransfers.map((t) => ({ ...t, month: monthOf(t.month) })),
  };
}
