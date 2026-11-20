import { and, eq, isNull, ne } from 'drizzle-orm';
import type { UpdateGroupRequest } from '../../shared/api/categories';
import type { ChangeRecorder } from '../commands/recorder';
import { applyOrder } from '../commands/reorder';
import type { Executor } from '../db/client';
import { nextSortOrder } from '../db/lookups';
import { category, categoryGroup } from '../db/schema';
import { AppError, DomainError } from '../http/errors';

type GroupRow = typeof categoryGroup.$inferSelect;

/** A live group, locked for the rest of the command. */
export async function loadGroup(db: Executor, id: string): Promise<GroupRow> {
  const [row] = await db
    .select()
    .from(categoryGroup)
    .where(and(eq(categoryGroup.id, id), isNull(categoryGroup.deletedAt)))
    .for('update');
  if (!row) throw new AppError(404, 'not_found', 'Category group not found.');
  return row;
}

const appManaged = () => new DomainError('system_group', 'This group is managed by the app.');
const notYours = () => new DomainError('system_group', 'Only your own groups can be renamed or deleted.');

export async function createGroup(rec: ChangeRecorder, name: string): Promise<{ id: string }> {
  const [group] = await rec.insert(categoryGroup, {
    name,
    kind: 'normal',
    sortOrder: await nextSortOrder(rec.tx, categoryGroup, isNull(categoryGroup.deletedAt)),
  });
  return { id: group!.id };
}

export async function updateGroup(
  rec: ChangeRecorder,
  id: string,
  input: UpdateGroupRequest,
): Promise<{ name: string }> {
  const group = await loadGroup(rec.tx, id);
  if (group.kind === 'internal') throw appManaged();
  if (input.name !== undefined && input.name !== group.name && group.kind !== 'normal') throw notYours();
  await rec.update(categoryGroup, eq(categoryGroup.id, id), { name: input.name, hidden: input.hidden });
  return { name: input.name ?? group.name };
}

/** Spec §10: a group can be deleted only when empty. Soft delete: deleted categories still point at it. */
export async function deleteGroup(rec: ChangeRecorder, id: string, now: Date): Promise<{ name: string }> {
  const group = await loadGroup(rec.tx, id);
  if (group.kind !== 'normal') throw notYours();
  const [live] = await rec.tx
    .select({ id: category.id })
    .from(category)
    .where(and(eq(category.groupId, id), isNull(category.deletedAt)))
    .limit(1);
  if (live) throw new DomainError('group_not_empty', "Move or delete this group's categories first.");
  await rec.update(categoryGroup, eq(categoryGroup.id, id), { deletedAt: now });
  return { name: group.name };
}

/** `ids` lists every live group except the internal one. */
export function reorderGroups(rec: ChangeRecorder, ids: string[]): Promise<void> {
  return applyOrder(rec, categoryGroup, and(isNull(categoryGroup.deletedAt), ne(categoryGroup.kind, 'internal')), ids);
}
