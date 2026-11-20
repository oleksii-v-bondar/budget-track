import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { CategoryDto, CategoryGroupDto, CategoryGroupKind, CategoryKind } from '../../shared/api/categories';
import type { Executor } from '../db/client';
import { category, categoryGroup } from '../db/schema';
import { AppError } from '../http/errors';

type CategoryRow = typeof category.$inferSelect;

export function categoryKindOf(
  row: Pick<CategoryRow, 'systemKind' | 'linkedAccountId'>,
  groupKind: CategoryGroupKind,
): CategoryKind {
  if (row.systemKind) return row.systemKind;
  if (row.linkedAccountId) return groupKind === 'cc_payments' ? 'cc_payment' : 'debt_payment';
  return 'normal';
}

function toDto(row: CategoryRow, groupKind: CategoryGroupKind): CategoryDto {
  return {
    id: row.id,
    groupId: row.groupId,
    name: row.name,
    kind: categoryKindOf(row, groupKind),
    hidden: row.hidden,
    note: row.note,
    sortOrder: row.sortOrder,
    linkedAccountId: row.linkedAccountId,
  };
}

/** Live groups with their live categories, both in display order. */
export async function listCategoryGroups(db: Executor, where?: SQL): Promise<CategoryGroupDto[]> {
  const groups = await db
    .select()
    .from(categoryGroup)
    .where(and(isNull(categoryGroup.deletedAt), where))
    .orderBy(asc(categoryGroup.sortOrder), asc(categoryGroup.createdAt), asc(categoryGroup.id));
  if (groups.length === 0) return [];
  const categories = await db
    .select()
    .from(category)
    .where(and(isNull(category.deletedAt), inArray(category.groupId, groups.map((g) => g.id))))
    .orderBy(asc(category.sortOrder), asc(category.createdAt), asc(category.id));
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    kind: g.kind,
    hidden: g.hidden,
    sortOrder: g.sortOrder,
    categories: categories.filter((c) => c.groupId === g.id).map((c) => toDto(c, g.kind)),
  }));
}

export async function getCategoryGroup(db: Executor, id: string): Promise<CategoryGroupDto> {
  const [group] = await listCategoryGroups(db, eq(categoryGroup.id, id));
  if (!group) throw new AppError(404, 'not_found', 'Category group not found.');
  return group;
}

export async function getCategory(db: Executor, id: string): Promise<CategoryDto> {
  const [row] = await db
    .select({ category, groupKind: categoryGroup.kind })
    .from(category)
    .innerJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
    .where(and(eq(category.id, id), isNull(category.deletedAt)));
  if (!row) throw new AppError(404, 'not_found', 'Category not found.');
  return toDto(row.category, row.groupKind);
}
