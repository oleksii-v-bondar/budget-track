import { eq, type SQL } from 'drizzle-orm';
import { account, category, categoryGroup } from '../db/schema';
import { DomainError } from '../http/errors';
import type { ChangeRecorder } from './recorder';

type Sortable = typeof account | typeof categoryGroup | typeof category;

/**
 * Sets sort_order 1..n in the order of `ids`, which must list every row in `scope` exactly once (the client sends the
 * whole list after a drag). Rows already in place aren't touched.
 */
export async function applyOrder(
  rec: ChangeRecorder,
  table: Sortable,
  scope: SQL | undefined,
  ids: string[],
): Promise<void> {
  const rows = await rec.tx.select({ id: table.id }).from(table).where(scope);
  const known = new Set(rows.map((row) => row.id));
  if (rows.length !== ids.length || !ids.every((id) => known.has(id))) {
    throw new DomainError('order_mismatch', 'The new order must list every item exactly once.');
  }
  for (const [index, id] of ids.entries()) {
    await rec.update(table, eq(table.id, id), { sortOrder: index + 1 });
  }
}
