import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { categoryGroup } from '../db/schema';
import { createTestApp, type TestApp } from '../test/app';
import { setUpBudget } from '../test/auth';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { runCommand } from './run-command';

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

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as unknown };
}

function createGroup(name: string) {
  return runCommand({ db: t.db }, `Create group "${name}"`, async (rec) => {
    const [group] = await rec.insert(categoryGroup, { name });
    return group!;
  });
}

describe('/api/undo and /api/redo', () => {
  it('shows, undoes and redoes the newest command', async () => {
    expect(await json(await ctx.client.get('/api/undo'))).toEqual({ status: 200, body: { undo: null, redo: null } });
    const group = await createGroup('Bills');
    expect(await json(await ctx.client.get('/api/undo'))).toEqual({
      status: 200,
      body: { undo: { label: 'Create group "Bills"' }, redo: null },
    });

    expect(await json(await ctx.client.post('/api/undo'))).toEqual({
      status: 200,
      body: { undo: null, redo: { label: 'Create group "Bills"' }, undone: { label: 'Create group "Bills"' } },
    });
    expect(await t.db.select().from(categoryGroup).where(eq(categoryGroup.id, group.id))).toEqual([]);

    expect(await json(await ctx.client.post('/api/redo'))).toEqual({
      status: 200,
      body: { undo: { label: 'Create group "Bills"' }, redo: null, redone: { label: 'Create group "Bills"' } },
    });
    expect(await t.db.select().from(categoryGroup).where(eq(categoryGroup.id, group.id))).toEqual([group]);
  });

  it('answers 409 when the data changed since, or when there is nothing to undo or redo', async () => {
    expect(await json(await ctx.client.post('/api/undo'))).toEqual({
      status: 409,
      body: { code: 'nothing_to_undo', message: 'Nothing to undo.' },
    });
    expect(await json(await ctx.client.post('/api/redo'))).toEqual({
      status: 409,
      body: { code: 'nothing_to_redo', message: 'Nothing to redo.' },
    });
    const group = await createGroup('Bills');
    await t.db.update(categoryGroup).set({ name: 'Edited elsewhere' }).where(eq(categoryGroup.id, group.id));
    expect(await json(await ctx.client.post('/api/undo'))).toEqual({
      status: 409,
      body: { code: 'undo_conflict', message: "Can't undo: data changed since." },
    });
  });
});
