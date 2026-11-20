import { eq } from 'drizzle-orm';
import { type IsoDate, type Month, monthOf } from '../../engine';
import type { SetTargetRequest, TargetDto } from '../../shared/api/targets';
import { assertBudgetMonth, monthStart } from '../budget/assignments';
import { loadCategory } from '../categories/category-commands';
import type { ChangeRecorder } from '../commands/recorder';
import type { Executor } from '../db/client';
import { target } from '../db/schema';
import { AppError, DomainError } from '../http/errors';
import { toTargetDto } from './target-model';

/** The columns a target request sets; the category, start month, snooze and timestamps are handled separately. */
type TargetFields = Omit<
  typeof target.$inferInsert,
  'categoryId' | 'startMonth' | 'snoozedMonth' | 'createdAt' | 'updatedAt'
>;

const UNUSED = {
  amount: 0,
  mode: null,
  dueWeekday: null,
  dueDayOfMonth: null,
  dueDate: null,
  repeatUnit: null,
  repeatEvery: null,
  debtMode: null,
} as const;

/** The stored columns of a target; every field the kind and cadence don't use is cleared. */
function targetFields(input: SetTargetRequest): TargetFields {
  if (input.kind === 'balance') {
    return { ...UNUSED, kind: 'balance', cadence: 'none', amount: input.amount, dueDate: input.dueDate };
  }
  if (input.kind === 'debt') {
    // The engine ignores the cadence of debt targets; `monthly` matches the paired loan target (P2b1).
    const debt = { ...UNUSED, kind: 'debt', cadence: 'monthly', debtMode: input.debtMode } as const;
    if (input.debtMode === 'fixed') return { ...debt, amount: input.amount };
    if (input.debtMode === 'payoff_by_date') return { ...debt, dueDate: input.dueDate };
    return debt;
  }
  const { cadence, amount, mode } = input;
  const spending = { ...UNUSED, kind: 'spending', cadence, amount, mode } as const;
  if (input.cadence === 'weekly') return { ...spending, dueWeekday: input.dueWeekday };
  if (input.cadence === 'monthly') return { ...spending, dueDayOfMonth: input.dueDayOfMonth };
  if (input.cadence === 'yearly') return { ...spending, dueDate: input.dueDate };
  return { ...spending, dueDate: input.dueDate, repeatUnit: input.repeatUnit, repeatEvery: input.repeatEvery };
}

const NO_TARGET = () => new AppError(404, 'not_found', 'This category has no target.');

/** A category that may have a target: any live category but Ready to Assign and Uncategorized. */
async function targetableCategory(rec: ChangeRecorder, categoryId: string) {
  const current = await loadCategory(rec.tx, categoryId);
  if (current.kind === 'rta' || current.kind === 'uncategorized') {
    throw new DomainError('system_category', "System categories can't have targets.");
  }
  return current;
}

async function findTarget(db: Executor, categoryId: string) {
  const [row] = await db.select().from(target).where(eq(target.categoryId, categoryId));
  return row ?? null;
}

export async function getTarget(db: Executor, categoryId: string): Promise<TargetDto> {
  const row = await findTarget(db, categoryId);
  if (!row) throw NO_TARGET();
  return toTargetDto(row);
}

/** Spec §4.3 and §6: creates or replaces the category's target (0..1 per category). */
export async function setTarget(
  rec: ChangeRecorder,
  categoryId: string,
  input: SetTargetRequest,
  today: IsoDate,
): Promise<{ name: string }> {
  const current = await targetableCategory(rec, categoryId);
  if (input.kind === 'debt' && current.kind !== 'cc_payment' && current.kind !== 'debt_payment') {
    throw new DomainError('debt_target_not_allowed', 'Only credit card payment and loan categories take debt targets.');
  }
  if (input.startMonth !== undefined) await assertBudgetMonth(rec.tx, input.startMonth, today);
  const existing = await findTarget(rec.tx, categoryId);
  const startMonth = input.startMonth
    ? monthStart(input.startMonth)
    : (existing?.startMonth ?? monthStart(monthOf(today)));
  const fields = { ...targetFields(input), startMonth };
  if (existing) await rec.update(target, eq(target.categoryId, categoryId), fields);
  else await rec.insert(target, { categoryId, ...fields });
  return { name: current.name };
}

export async function deleteTarget(rec: ChangeRecorder, categoryId: string): Promise<{ name: string }> {
  const current = await loadCategory(rec.tx, categoryId);
  if ((await rec.delete(target, eq(target.categoryId, categoryId))).length === 0) throw NO_TARGET();
  return { name: current.name };
}

/** Spec §6: a snoozed target isn't underfunded in that month. `null` unsnoozes. */
export async function snoozeTarget(
  rec: ChangeRecorder,
  categoryId: string,
  month: Month | null,
  today: IsoDate,
): Promise<{ name: string }> {
  const current = await loadCategory(rec.tx, categoryId);
  if (!(await findTarget(rec.tx, categoryId))) throw NO_TARGET();
  if (month !== null) await assertBudgetMonth(rec.tx, month, today);
  await rec.update(target, eq(target.categoryId, categoryId), { snoozedMonth: month && monthStart(month) });
  return { name: current.name };
}
