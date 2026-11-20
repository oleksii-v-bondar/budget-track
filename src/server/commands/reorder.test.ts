import { inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { categoryGroup } from '../db/schema';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { applyOrder } from './reorder';
import { runCommand } from './run-command';

let t: TestDatabase;
beforeEach(async () => {
  t = await createTestDatabase();
});
afterEach(async () => {
  await t.drop();
});

describe('applyOrder', () => {
  it('refuses a list that repeats an item, even when the count matches', async () => {
    const [a, b] = await t.db.insert(categoryGroup).values([{ name: 'A' }, { name: 'B' }]).returning();
    const scope = inArray(categoryGroup.id, [a!.id, b!.id]);
    const order = (ids: string[]) =>
      runCommand({ db: t.db }, 'Reorder', (rec) => applyOrder(rec, categoryGroup, scope, ids));

    await expect(order([a!.id, a!.id])).rejects.toMatchObject({
      status: 422,
      code: 'order_mismatch',
      message: 'The new order must list every item exactly once.',
    });
    await order([b!.id, a!.id]);
    const rows = await t.db
      .select({ name: categoryGroup.name })
      .from(categoryGroup)
      .where(scope)
      .orderBy(categoryGroup.sortOrder);
    expect(rows.map((r) => r.name)).toEqual(['B', 'A']);
  });
});
