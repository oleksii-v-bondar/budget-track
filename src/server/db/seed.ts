import type { Db, Executor } from './client';
import { appUser, category, categoryGroup } from './schema';

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

/**
 * On first start: creates the `app_user` row that holds the budget's settings, with the budget starting in `month`
 * (`'YYYY-MM'`), and seeds the budget. Does nothing once the row exists.
 */
export async function ensureBudget(db: Db, month: string): Promise<void> {
  await db.transaction(async (tx) => {
    // The singleton index lets only one row in, so a second process racing this one inserts nothing.
    const created = await tx
      .insert(appUser)
      .values({ budgetStartMonth: `${month}-01` })
      .onConflictDoNothing()
      .returning({ id: appUser.id });
    if (created.length > 0) await seedBudget(tx);
  });
}
