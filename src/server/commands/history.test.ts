import { eq, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { account, assignment, category, categoryGroup, undoEntry } from '../db/schema';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { snapshot } from '../test/snapshot';
import { historyState, redo, undo } from './history';
import { type Change, primaryKeyOf, type RecordedTable } from './recorder';
import { runCommand, UNDO_HISTORY_LIMIT } from './run-command';

let t: TestDatabase;
beforeEach(async () => {
  t = await createTestDatabase();
});
afterEach(async () => {
  await t.drop();
});

const deps = () => ({ db: t.db });

function createGroup(name: string) {
  return runCommand(deps(), `Create ${name}`, async (rec) => (await rec.insert(categoryGroup, { name }))[0]!);
}

function renameGroup(id: string, name: string) {
  return runCommand(deps(), `Rename to ${name}`, (rec) =>
    rec.update(categoryGroup, eq(categoryGroup.id, id), { name }),
  );
}

async function entries() {
  return t.db.select().from(undoEntry).orderBy(undoEntry.id);
}

const kindOf = (c: Change) => (c.before === null ? 'insert' : c.after === null ? 'delete' : 'update');

describe('runCommand', () => {
  it('records ordered, JSON-safe before/after images of every insert, update and delete', async () => {
    const { group, rent } = await runCommand(deps(), 'Mixed', async (rec) => {
      const [group] = await rec.insert(categoryGroup, { name: 'Bills' });
      const [rent] = await rec.insert(category, { groupId: group!.id, name: 'Rent' });
      await rec.update(category, eq(category.id, rent!.id), { name: 'Rent & bills' });
      await rec.insert(assignment, { categoryId: rent!.id, month: '2026-11-01', amount: 150_000 });
      await rec.delete(assignment, eq(assignment.categoryId, rent!.id));
      return { group: group!, rent: rent! };
    });

    const [entry] = await entries();
    expect(entry).toMatchObject({ label: 'Mixed', state: 'done' });
    const changes = entry!.changes as Change[];
    expect(changes.map((c) => [c.table, kindOf(c)])).toEqual([
      ['category_group', 'insert'],
      ['category', 'insert'],
      ['category', 'update'],
      ['assignment', 'insert'],
      ['assignment', 'delete'],
    ]);
    expect(changes[0]).toEqual({
      table: 'category_group',
      pk: { id: group.id },
      before: null,
      after: {
        id: group.id,
        name: 'Bills',
        sortOrder: 0,
        hidden: false,
        kind: 'normal',
        deletedAt: null,
        createdAt: group.createdAt.toISOString(),
        updatedAt: group.updatedAt.toISOString(),
      },
    });
    expect([changes[2]!.before!.name, changes[2]!.after!.name]).toEqual(['Rent', 'Rent & bills']);
    expect(changes[4]).toMatchObject({
      pk: { categoryId: rent.id, month: '2026-11-01' },
      before: { categoryId: rent.id, month: '2026-11-01', amount: 150_000 },
      after: null,
    });
  });

  it('keeps numerics as decimal strings and leaves generated columns out of images', async () => {
    await runCommand(deps(), 'Create loan', (rec) =>
      rec.insert(account, { name: 'Mortgage', type: 'mortgage', interestRate: '6.5', minPayment: 250_000 }),
    );
    const [change] = (await entries())[0]!.changes as Change[];
    expect(change!.after).toMatchObject({ interestRate: '6.5000', minPayment: 250_000 });
    expect(change!.after).not.toHaveProperty('accountClass');
  });

  it('records nothing for a no-op, so the history (including redo) stays as it was', async () => {
    const group = await createGroup('Bills');
    await renameGroup(group.id, 'Utilities');
    await undo(t.db);
    expect(await renameGroup(group.id, 'Bills')).toEqual([]);
    expect((await entries()).map((e) => [e.label, e.state])).toEqual([
      ['Create Bills', 'done'],
      ['Rename to Utilities', 'undone'],
    ]);
  });

  it('rolls back every write and records nothing when the command fails', async () => {
    const failing = runCommand(deps(), 'Fails', async (rec) => {
      await rec.insert(categoryGroup, { name: 'Bills' });
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    expect(await t.db.select().from(categoryGroup)).toEqual([]);
    expect(await entries()).toEqual([]);
  });

  it('clears the redo stack on a new command and keeps only the newest 100 done entries', async () => {
    const group = await createGroup('Bills');
    await renameGroup(group.id, 'Undone');
    await undo(t.db);
    for (let i = 1; i <= UNDO_HISTORY_LIMIT; i += 1) await renameGroup(group.id, `Name ${i}`);
    const rows = await entries();
    expect(rows).toHaveLength(UNDO_HISTORY_LIMIT);
    expect(rows.every((e) => e.state === 'done')).toBe(true);
    expect([rows[0]!.label, rows.at(-1)!.label]).toEqual(['Rename to Name 1', 'Rename to Name 100']);
  });

  it('refuses writes that would escape the recorder: primary key changes and updates without WHERE', async () => {
    const group = await createGroup('Bills');
    const pkChange = runCommand(deps(), 'Bad', (rec) =>
      rec.update(categoryGroup, eq(categoryGroup.id, group.id), { id: crypto.randomUUID() }),
    );
    await expect(pkChange).rejects.toThrow('Recorded updates cannot change primary keys');
    const everything = runCommand(deps(), 'Bad', (rec) => rec.delete(categoryGroup, undefined));
    await expect(everything).rejects.toThrow('Recorded updates and deletes need a WHERE condition');
  });

  it('refuses tables without a primary key, whose rows undo could not find again', () => {
    const keyless = pgTable('keyless', { name: text('name') });
    expect(() => primaryKeyOf(keyless as unknown as RecordedTable)).toThrow('Table keyless has no primary key');
  });
});

describe('undo and redo', () => {
  it('restore the exact state before and after a bulk command', async () => {
    const setup = await runCommand(deps(), 'Setup', async (rec) => {
      const [group] = await rec.insert(categoryGroup, { name: 'Bills' });
      const cats = await rec.insert(
        category,
        ['Rent', 'Power', 'Water'].map((name, i) => ({ groupId: group!.id, name, sortOrder: i })),
      );
      await rec.insert(
        assignment,
        cats.map((c, i) => ({ categoryId: c.id, month: '2026-11-01', amount: 10_000 * (i + 1) })),
      );
      return { group: group!, cats };
    });
    const before = await snapshot(t.db);

    await runCommand(deps(), 'Bulk', async (rec) => {
      await rec.update(category, eq(category.groupId, setup.group.id), { hidden: true, note: 'archived' });
      await rec.delete(assignment, eq(assignment.month, '2026-11-01'));
      await rec.insert(category, { groupId: setup.group.id, name: 'Internet', sortOrder: 3 });
      await rec.update(categoryGroup, eq(categoryGroup.id, setup.group.id), {
        name: 'Old bills',
        deletedAt: new Date(),
      });
    });
    const after = await snapshot(t.db);
    expect(after).not.toEqual(before);

    expect(await undo(t.db)).toEqual({ label: 'Bulk' });
    expect(await snapshot(t.db)).toEqual(before);
    expect(await redo(t.db)).toEqual({ label: 'Bulk' });
    expect(await snapshot(t.db)).toEqual(after);
  });

  it('report what Undo and Redo would do next', async () => {
    expect(await historyState(t.db)).toEqual({ undo: null, redo: null });
    const group = await createGroup('Bills');
    await renameGroup(group.id, 'Utilities');
    expect(await historyState(t.db)).toEqual({ undo: { label: 'Rename to Utilities' }, redo: null });
    await undo(t.db);
    const middle = { undo: { label: 'Create Bills' }, redo: { label: 'Rename to Utilities' } };
    expect(await historyState(t.db)).toEqual(middle);
    await undo(t.db);
    expect(await historyState(t.db)).toEqual({ undo: null, redo: { label: 'Create Bills' } });
    await redo(t.db);
    expect(await historyState(t.db)).toEqual(middle);
  });

  it('refuse to undo when a row changed since, leaving everything as it was', async () => {
    const group = await createGroup('Bills');
    await renameGroup(group.id, 'Utilities');
    await t.db.update(categoryGroup).set({ hidden: true }).where(eq(categoryGroup.id, group.id));
    const state = await snapshot(t.db);

    await expect(undo(t.db)).rejects.toMatchObject({
      status: 409,
      code: 'undo_conflict',
      message: "Can't undo: data changed since.",
    });
    expect(await snapshot(t.db)).toEqual(state);
    expect((await entries()).map((e) => e.state)).toEqual(['done', 'done']);
  });

  it('refuse to undo an insert whose row is gone, and to redo when a row changed since', async () => {
    const group = await createGroup('Bills');
    await t.db.delete(categoryGroup).where(eq(categoryGroup.id, group.id));
    await expect(undo(t.db)).rejects.toMatchObject({ code: 'undo_conflict' });

    const other = await createGroup('Food');
    await renameGroup(other.id, 'Groceries');
    await undo(t.db);
    await t.db.update(categoryGroup).set({ name: 'Dining' }).where(eq(categoryGroup.id, other.id));
    await expect(redo(t.db)).rejects.toMatchObject({
      status: 409,
      code: 'undo_conflict',
      message: "Can't redo: data changed since.",
    });
  });

  it('refuse to undo or redo when another row still depends on the change, instead of failing', async () => {
    const group = await createGroup('Bills');
    // Written outside the recorder: undoing the create would delete the group this category belongs to.
    await t.db.insert(category).values({ groupId: group.id, name: 'Rent' });
    const state = await snapshot(t.db);
    await expect(undo(t.db)).rejects.toMatchObject({
      status: 409,
      code: 'undo_conflict',
      message: "Can't undo: data changed since.",
    });
    expect(await snapshot(t.db)).toEqual(state);
    expect((await entries()).map((e) => e.state)).toEqual(['done']);

    const [food] = await t.db.insert(categoryGroup).values({ name: 'Food' }).returning();
    await runCommand(deps(), 'Create Groceries', (rec) =>
      rec.insert(category, { groupId: food!.id, name: 'Groceries' }),
    );
    await undo(t.db);
    // Redoing would insert a category whose group no longer exists.
    await t.db.delete(categoryGroup).where(eq(categoryGroup.id, food!.id));
    await expect(redo(t.db)).rejects.toMatchObject({
      status: 409,
      code: 'undo_conflict',
      message: "Can't redo: data changed since.",
    });
    expect((await entries()).map((e) => e.state)).toEqual(['done', 'undone']);
  });

  it('ignore timestamp-only differences', async () => {
    const group = await createGroup('Bills');
    await renameGroup(group.id, 'Utilities');
    await t.db.execute(sql`update category_group set updated_at = updated_at + interval '1 hour'`);
    await expect(undo(t.db)).resolves.toEqual({ label: 'Rename to Utilities' });
    const [row] = await t.db.select().from(categoryGroup);
    expect(row!.name).toBe('Bills');
  });

  it('say when there is nothing to undo or redo', async () => {
    const nothing = (code: string, message: string) => ({ status: 409, code, message });
    await expect(undo(t.db)).rejects.toMatchObject(nothing('nothing_to_undo', 'Nothing to undo.'));
    await expect(redo(t.db)).rejects.toMatchObject(nothing('nothing_to_redo', 'Nothing to redo.'));
  });
});
