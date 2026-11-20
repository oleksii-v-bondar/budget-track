import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CategoryGroupDto, CategoryListResponse } from '../../shared/api/categories';
import { systemGroupId } from '../db/lookups';
import { category, categoryGroup } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { createCategory, createGroup } from '../test/fixtures';
import { snapshot } from '../test/snapshot';

let t: TestDatabase;
let ctx: TestApp;
beforeEach(async () => {
  t = await createTestDatabase();
  ctx = createTestApp(t.db);
  await setUpBudget(ctx);
});
afterEach(async () => {
  await t.drop();
});

async function json<T = Record<string, unknown>>(res: Response) {
  return { status: res.status, body: (await res.json()) as T };
}

const patch = (id: string, body: object) => ctx.client.send('PATCH', `/api/category-groups/${id}`, body);
const remove = (id: string) => ctx.client.send('DELETE', `/api/category-groups/${id}`);

async function groups() {
  return (await json<CategoryListResponse>(await ctx.client.get('/api/categories'))).body.groups;
}

describe('/api/category-groups', () => {
  it('creates groups at the end, then renames and hides them', async () => {
    const res = await json<CategoryGroupDto>(await ctx.client.post('/api/category-groups', { name: ' Bills ' }));
    expect(res).toEqual({
      status: 201,
      body: { id: expect.any(String), name: 'Bills', kind: 'normal', hidden: false, sortOrder: 3, categories: [] },
    });
    const edited = await json<CategoryGroupDto>(await patch(res.body.id, { name: 'Utilities', hidden: true }));
    expect(edited.body).toMatchObject({ name: 'Utilities', hidden: true });
    expect((await groups()).map((g) => [g.name, g.kind, g.hidden])).toEqual([
      ['Internal', 'internal', true],
      ['Credit Card Payments', 'cc_payments', false],
      ['Debt Payments', 'debt_payments', false],
      ['Utilities', 'normal', true],
    ]);
    expect((await json(await ctx.client.get('/api/undo'))).body).toMatchObject({
      undo: { label: 'Edit group "Utilities"' },
    });
  });

  it("protects the app's groups: they can be hidden but not renamed or deleted, and Internal is locked", async () => {
    const cards = await systemGroupId(t.db, 'cc_payments');
    const internal = await systemGroupId(t.db, 'internal');
    const notYours = {
      status: 422,
      body: { code: 'system_group', message: 'Only your own groups can be renamed or deleted.' },
    };
    expect(await json(await patch(cards, { name: 'Cards' }))).toEqual(notYours);
    expect(await json(await remove(cards))).toEqual(notYours);
    expect((await json<CategoryGroupDto>(await patch(cards, { hidden: true }))).body.hidden).toBe(true);
    expect((await json(await patch(cards, { name: 'Credit Card Payments' }))).status).toBe(200);
    expect(await json(await patch(internal, { hidden: false }))).toEqual({
      status: 422,
      body: { code: 'system_group', message: 'This group is managed by the app.' },
    });
    expect(await json(await patch(crypto.randomUUID(), { hidden: true }))).toEqual({
      status: 404,
      body: { code: 'not_found', message: 'Category group not found.' },
    });
  });

  it('deletes only groups without live categories, as an undoable soft delete', async () => {
    const bills = await createGroup(ctx.client, 'Bills');
    const rent = await createCategory(ctx.client, bills.id, 'Rent');
    expect(await json(await remove(bills.id))).toEqual({
      status: 422,
      body: { code: 'group_not_empty', message: "Move or delete this group's categories first." },
    });

    await t.db.update(category).set({ deletedAt: new Date() }).where(eq(category.id, rent.id));
    const before = await snapshot(t.db);
    expect(await json(await remove(bills.id))).toEqual({ status: 200, body: { id: bills.id } });
    const [row] = await t.db.select().from(categoryGroup).where(eq(categoryGroup.id, bills.id));
    expect(row!.deletedAt).toEqual(ctx.clock.now());
    expect((await groups()).map((g) => g.name)).not.toContain('Bills');
    expect((await json(await patch(bills.id, { name: 'Again' }))).status).toBe(404);

    await ctx.client.post('/api/undo');
    expect(await snapshot(t.db)).toEqual(before);
  });

  it('reorders every live group except the internal one', async () => {
    const bills = await createGroup(ctx.client, 'Bills');
    const cards = await systemGroupId(t.db, 'cc_payments');
    const debts = await systemGroupId(t.db, 'debt_payments');
    const order = (ids: string[]) => ctx.client.send('PUT', '/api/category-groups/order', { ids });

    expect(await json(await order([bills.id, debts, cards]))).toEqual({
      status: 200,
      body: { ids: [bills.id, debts, cards] },
    });
    expect((await groups()).map((g) => g.name)).toEqual(['Internal', 'Bills', 'Debt Payments', 'Credit Card Payments']);
    expect((await json(await order([bills.id, cards]))).body).toMatchObject({ code: 'order_mismatch' });
    const internal = await systemGroupId(t.db, 'internal');
    const withInternal = await order([internal, bills.id, debts, cards]);
    expect((await json(withInternal)).body).toMatchObject({ code: 'order_mismatch' });
  });
});
