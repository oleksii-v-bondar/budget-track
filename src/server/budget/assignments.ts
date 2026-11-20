import { and, eq, isNull, sql } from 'drizzle-orm';
import type { MoveMoneyRequest } from '../../shared/api/budget';
import { addMonths, type IsoDate, type Money, type Month, monthOf } from '../../engine';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { appUser, assignment, category, monthNote, transaction } from '../db/schema';
import { AppError, DomainError } from '../http/errors';

/** P2 carry-over: assignments may reach at most 24 months past the current month (the UI's navigation limit). */
export const MONTHS_AHEAD = 24;

/** Months are 'YYYY-MM' in the API and the engine, and their first day in the database. */
export const monthStart = (month: Month): IsoDate => `${month}-01`;

/** Spec §5.1: the budget starts at budget_start_month or the month of the earliest transaction, whichever is first. */
export async function budgetStartMonth(db: Executor): Promise<Month> {
  const [user] = await db.select({ start: appUser.budgetStartMonth }).from(appUser);
  const [earliest] = await db
    .select({ date: sql<IsoDate | null>`min(${transaction.date})` })
    .from(transaction)
    .where(isNull(transaction.deletedAt));
  return earliestMonth([user!.start, earliest?.date]);
}

const earliestMonth = (dates: (IsoDate | null | undefined)[]): Month =>
  dates
    .filter((d): d is IsoDate => !!d)
    .map(monthOf)
    .reduce((a, b) => (a < b ? a : b));

/**
 * The budget start can move later (e.g. when the only early account is deleted); earlier months that still hold an
 * assignment or a note stay editable so those rows can be changed or cleared.
 */
export async function firstEditableMonth(db: Executor): Promise<Month> {
  const [held] = await db.select({ date: sql<IsoDate | null>`min(${assignment.month})` }).from(assignment);
  const [noted] = await db.select({ date: sql<IsoDate | null>`min(${monthNote.month})` }).from(monthNote);
  return earliestMonth([monthStart(await budgetStartMonth(db)), held?.date, noted?.date]);
}

export async function assertBudgetMonth(db: Executor, month: Month, today: IsoDate): Promise<void> {
  const first = await firstEditableMonth(db);
  const last = addMonths(monthOf(today), MONTHS_AHEAD);
  if (month < first || month > last) {
    throw new DomainError('month_out_of_range', `Pick a month from ${first} to ${last}.`);
  }
}

/** A live category that can hold assignments: anything but Ready to Assign and Uncategorized (spec §3). */
export async function assignableCategory(db: Executor, id: string): Promise<{ name: string }> {
  const [row] = await db
    .select({ name: category.name, systemKind: category.systemKind })
    .from(category)
    .where(and(eq(category.id, id), isNull(category.deletedAt)));
  if (!row) throw new AppError(404, 'not_found', 'Category not found.');
  if (row.systemKind) throw new DomainError('category_not_assignable', "Money can't be assigned to this category.");
  return { name: row.name };
}

const assignmentWhere = (categoryId: string, month: Month) =>
  and(eq(assignment.categoryId, categoryId), eq(assignment.month, monthStart(month)));

export async function assignedIn(db: Executor, categoryId: string, month: Month): Promise<Money> {
  const [row] = await db
    .select({ amount: assignment.amount })
    .from(assignment)
    .where(assignmentWhere(categoryId, month));
  return row?.amount ?? 0;
}

/** Sets Assigned(category, month); assignments are sparse, so 0 deletes the row (spec §4.3). */
export async function setAssigned(rec: ChangeRecorder, categoryId: string, month: Month, amount: Money): Promise<void> {
  if (!Number.isSafeInteger(amount)) throw new DomainError('amount_too_large', 'That amount is too large.');
  const where = assignmentWhere(categoryId, month);
  if (amount === 0) {
    await rec.delete(assignment, where);
  } else if ((await assignedIn(rec.tx, categoryId, month)) !== 0) {
    await rec.update(assignment, where, { amount });
  } else {
    await rec.insert(assignment, { categoryId, month: monthStart(month), amount });
  }
}

export async function addAssigned(rec: ChangeRecorder, categoryId: string, month: Month, delta: Money): Promise<void> {
  await setAssigned(rec, categoryId, month, (await assignedIn(rec.tx, categoryId, month)) + delta);
}

/**
 * Spec §3: moving to or from Ready to Assign (null) changes only the other category's Assigned.
 * Like `setAssigned`, it expects the caller to have checked the categories (`assignableCategory`) and the month.
 */
export async function moveMoney(rec: ChangeRecorder, month: Month, move: MoveMoneyRequest): Promise<string[]> {
  const touched: string[] = [];
  for (const [id, delta] of [
    [move.from, -move.amount],
    [move.to, move.amount],
  ] as const) {
    if (id === null) continue;
    await addAssigned(rec, id, month, delta);
    touched.push(id);
  }
  return touched;
}

/** Sets the month's note; an empty note deletes it. */
export async function setMonthNote(rec: ChangeRecorder, month: Month, note: string): Promise<void> {
  const where = eq(monthNote.month, monthStart(month));
  const [existing] = await rec.tx.select({ month: monthNote.month }).from(monthNote).where(where);
  if (note === '') await rec.delete(monthNote, where);
  else if (existing) await rec.update(monthNote, where, { note });
  else await rec.insert(monthNote, { month: monthStart(month), note });
}
