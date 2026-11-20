import { and, eq, isNull } from 'drizzle-orm';
import type { CategoryKind, CreateCategoryRequest, UpdateCategoryRequest } from '../../shared/api/categories';
import { addAssigned } from '../budget/assignments';
import type { ChangeRecorder } from '../commands/recorder';
import { applyOrder } from '../commands/reorder';
import type { Executor } from '../db/client';
import { nextSortOrder } from '../db/lookups';
import {
  assignment,
  category,
  categoryGroup,
  payee,
  scheduledSubtransaction,
  scheduledTransaction,
  subtransaction,
  target,
  transaction,
} from '../db/schema';
import { AppError, DomainError } from '../http/errors';
import { categoryKindOf } from './category-queries';

type CategoryRow = typeof category.$inferSelect;

/** A live category with its kind, locked for the rest of the command; null if there is none. */
async function findCategory(db: Executor, id: string): Promise<(CategoryRow & { kind: CategoryKind }) | null> {
  const [row] = await db
    .select({ category, groupKind: categoryGroup.kind })
    .from(category)
    .innerJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
    .where(and(eq(category.id, id), isNull(category.deletedAt)))
    .for('update', { of: category });
  return row ? { ...row.category, kind: categoryKindOf(row.category, row.groupKind) } : null;
}

export async function loadCategory(db: Executor, id: string): Promise<CategoryRow & { kind: CategoryKind }> {
  const row = await findCategory(db, id);
  if (!row) throw new AppError(404, 'not_found', 'Category not found.');
  return row;
}

/** Categories can only be created in, and moved to, a live group the user owns. */
async function assertNormalGroup(db: Executor, groupId: string): Promise<void> {
  const [group] = await db
    .select({ kind: categoryGroup.kind })
    .from(categoryGroup)
    .where(and(eq(categoryGroup.id, groupId), isNull(categoryGroup.deletedAt)));
  if (group?.kind !== 'normal') throw new DomainError('invalid_group', 'Choose one of your own category groups.');
}

const lastIn = (db: Executor, groupId: string) =>
  nextSortOrder(db, category, and(eq(category.groupId, groupId), isNull(category.deletedAt)));

export async function createCategory(rec: ChangeRecorder, input: CreateCategoryRequest): Promise<{ id: string }> {
  await assertNormalGroup(rec.tx, input.groupId);
  const [created] = await rec.insert(category, {
    groupId: input.groupId,
    name: input.name,
    note: input.note || null,
    sortOrder: await lastIn(rec.tx, input.groupId),
  });
  return { id: created!.id };
}

/** Spec §10 "Categories": rename, note, hide and move; what a category accepts depends on its kind. */
export async function updateCategory(
  rec: ChangeRecorder,
  id: string,
  input: UpdateCategoryRequest,
): Promise<{ name: string }> {
  const current = await loadCategory(rec.tx, id);
  if (current.kind === 'rta' || current.kind === 'uncategorized') {
    throw new DomainError('system_category', "System categories can't be changed.");
  }
  const renamed = input.name !== undefined && input.name !== current.name;
  const moved = input.groupId !== undefined && input.groupId !== current.groupId;
  if (current.kind !== 'normal' && (renamed || moved)) {
    throw new DomainError('linked_category', "This category follows its account: it can't be renamed or moved.");
  }
  let sortOrder: number | undefined;
  if (moved) {
    await assertNormalGroup(rec.tx, input.groupId!);
    sortOrder = await lastIn(rec.tx, input.groupId!);
  }
  await rec.update(category, eq(category.id, id), {
    name: input.name,
    note: input.note === undefined ? undefined : input.note || null,
    hidden: input.hidden,
    groupId: moved ? input.groupId : undefined,
    sortOrder,
  });
  return { name: input.name ?? current.name };
}

/** `ids` lists every live category of the group (any group but the internal one). */
export async function reorderCategories(rec: ChangeRecorder, groupId: string, ids: string[]): Promise<void> {
  const [group] = await rec.tx
    .select({ kind: categoryGroup.kind })
    .from(categoryGroup)
    .where(and(eq(categoryGroup.id, groupId), isNull(categoryGroup.deletedAt)));
  if (!group || group.kind === 'internal') {
    throw new DomainError('invalid_group', 'Choose one of your own category groups.');
  }
  await applyOrder(rec, category, and(eq(category.groupId, groupId), isNull(category.deletedAt)), ids);
}

/**
 * Spec §10: moves every transaction, split line, schedule, payee default and assignment (summed per month) to the
 * destination, then deletes the target and soft-deletes the category. Children are re-pointed explicitly, never by
 * cascades, so undo sees each row.
 */
export async function deleteCategory(
  rec: ChangeRecorder,
  id: string,
  destinationId: string,
  now: Date,
): Promise<{ name: string }> {
  const doomed = await loadCategory(rec.tx, id);
  if (doomed.kind === 'rta' || doomed.kind === 'uncategorized') {
    throw new DomainError('system_category', "System categories can't be changed.");
  }
  if (doomed.kind !== 'normal') {
    throw new DomainError('linked_category', "This category belongs to an account and can't be deleted.");
  }
  const destination = destinationId === id ? null : await findCategory(rec.tx, destinationId);
  if (destination?.kind !== 'normal') {
    throw new DomainError(
      'invalid_destination',
      'Choose another regular category to receive the money and transactions.',
    );
  }

  const to = { categoryId: destinationId };
  await rec.update(transaction, eq(transaction.categoryId, id), to);
  await rec.update(subtransaction, eq(subtransaction.categoryId, id), to);
  await rec.update(scheduledTransaction, eq(scheduledTransaction.categoryId, id), to);
  await rec.update(scheduledSubtransaction, eq(scheduledSubtransaction.categoryId, id), to);
  await rec.update(payee, eq(payee.lastCategoryId, id), { lastCategoryId: destinationId });
  const moved = await rec.delete(assignment, eq(assignment.categoryId, id));
  for (const row of moved) await addAssigned(rec, destinationId, row.month.slice(0, 7), row.amount);
  await rec.delete(target, eq(target.categoryId, id));
  await rec.update(category, eq(category.id, id), { deletedAt: now });
  return { name: doomed.name };
}
