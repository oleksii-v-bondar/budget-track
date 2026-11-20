import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { Executor } from './client';
import { account, category, categoryGroup, payee } from './schema';

type SystemPayeeKind = NonNullable<typeof payee.$inferSelect.systemKind>;
type SystemCategoryKind = NonNullable<typeof category.$inferSelect.systemKind>;
type SystemGroupKind = Exclude<typeof categoryGroup.$inferSelect.kind, 'normal'>;

/** The system payee of `kind`; created by migration 0002, so a miss is a broken database. */
export async function systemPayeeId(db: Executor, kind: SystemPayeeKind): Promise<string> {
  const [row] = await db.select({ id: payee.id }).from(payee).where(eq(payee.systemKind, kind));
  if (!row) throw new Error(`System payee ${kind} is missing`);
  return row.id;
}

/** Ready to Assign or Uncategorized (seeded at setup). */
export async function systemCategoryId(db: Executor, kind: SystemCategoryKind): Promise<string> {
  const [row] = await db.select({ id: category.id }).from(category).where(eq(category.systemKind, kind));
  if (!row) throw new Error(`System category ${kind} is missing`);
  return row.id;
}

/** The internal, credit card payments or debt payments group (seeded at setup). */
export async function systemGroupId(db: Executor, kind: SystemGroupKind): Promise<string> {
  const [row] = await db
    .select({ id: categoryGroup.id })
    .from(categoryGroup)
    .where(and(eq(categoryGroup.kind, kind), isNull(categoryGroup.deletedAt)));
  if (!row) throw new Error(`Category group ${kind} is missing`);
  return row.id;
}

/** One past the highest sort_order of the rows matching `where`, so a new row goes last. */
export async function nextSortOrder(
  db: Executor,
  table: typeof account | typeof categoryGroup | typeof category,
  where?: SQL,
): Promise<number> {
  const [row] = await db
    .select({ next: sql<number>`coalesce(max(${table.sortOrder}), 0) + 1` })
    .from(table)
    .where(where);
  return row!.next;
}
