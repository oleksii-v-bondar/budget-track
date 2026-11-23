import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { appUser, category, categoryGroup } from './schema';
import { ensureBudget } from './seed';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});

describe('ensureBudget', () => {
  it('creates the settings row and seeds the budget once, even when two starts race', async () => {
    await Promise.all([ensureBudget(t.db, '2026-11'), ensureBudget(t.db, '2026-11')]);
    await ensureBudget(t.db, '2027-01');
    expect(await t.db.select({ start: appUser.budgetStartMonth, currency: appUser.baseCurrency }).from(appUser)).toEqual([
      { start: '2026-11-01', currency: 'PLN' },
    ]);
    expect(await t.db.$count(categoryGroup)).toBe(3);
    expect(await t.db.$count(category)).toBe(2);
  });
});
