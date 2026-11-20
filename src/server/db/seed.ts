import type { Executor } from './client';
import { category, categoryGroup } from './schema';

/**
 * Creates the rows every budget needs (spec §3): the hidden internal group with the Ready to Assign and
 * Uncategorized system categories, plus the groups that will hold credit card payment and debt categories.
 */
export async function seedBudget(db: Executor): Promise<void> {
  const [internal] = await db
    .insert(categoryGroup)
    .values({ name: 'Internal', kind: 'internal', hidden: true, sortOrder: 0 })
    .returning({ id: categoryGroup.id });
  await db.insert(category).values([
    { groupId: internal!.id, name: 'Ready to Assign', systemKind: 'rta', hidden: true, sortOrder: 0 },
    { groupId: internal!.id, name: 'Uncategorized', systemKind: 'uncategorized', hidden: true, sortOrder: 1 },
  ]);
  await db.insert(categoryGroup).values([
    { name: 'Credit Card Payments', kind: 'cc_payments', sortOrder: 1 },
    { name: 'Debt Payments', kind: 'debt_payments', sortOrder: 2 },
  ]);
}
