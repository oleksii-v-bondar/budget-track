import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asc, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { runMigrations } from './migrate';
import { bankImport, undoEntry } from './schema';

// Scratch space inside the (git-ignored) node_modules cache.
const SCRATCH = join('node_modules', '.cache', 'budget-track-tests');

let t: TestDatabase;
let folder: string;
beforeEach(async () => {
  t = await createTestDatabase({ empty: true });
  await mkdir(SCRATCH, { recursive: true });
  folder = await mkdtemp(join(SCRATCH, 'migrations-'));
});
afterEach(async () => {
  await t.drop();
  await rm(folder, { recursive: true, force: true });
});

interface Journal {
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
}

/** drizzle/ plus one harmless migration, as the next release would ship it. */
async function withExtraMigration(): Promise<string> {
  await cp('drizzle', folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
  const last = journal.entries.at(-1)!;
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: '9999_test_extra' });
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(join(folder, '9999_test_extra.sql'), 'SELECT 1;');
  return folder;
}

/** drizzle/ as it was when `tag` was the latest migration. */
async function migrationsUpTo(tag: string): Promise<string> {
  await cp('drizzle', folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === tag) + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return folder;
}

const labels = async () => (await t.db.select({ label: undoEntry.label }).from(undoEntry)).map((e) => e.label);

describe('runMigrations', () => {
  it('migrates an empty database, and clears the undo history only when it applies a migration', async () => {
    await runMigrations(t.db, 'drizzle');
    await t.db.insert(undoEntry).values({ label: 'Create group "Bills"', changes: [] });

    await runMigrations(t.db, 'drizzle');
    expect(await labels()).toEqual(['Create group "Bills"']);

    await runMigrations(t.db, await withExtraMigration());
    expect(await labels()).toEqual([]);
  });

  it('records every bank import made before bank_import existed, by account and bank reference', async () => {
    await runMigrations(t.db, await migrationsUpTo('0011_payee_memory'));
    const insert = async (query: ReturnType<typeof sql>) => (await t.db.execute<{ id: string }>(query)).map((r) => r.id);
    const [pko] = await insert(sql`insert into account (name, type) values ('PKO', 'checking') returning id`);
    const [group] = await insert(sql`insert into category_group (name) values ('Food') returning id`);
    const [food] = await insert(sql`insert into category (group_id, name) values (${group}, 'Groceries') returning id`);
    // An import from an earlier session's account uid, deleted, and an entry made by hand.
    const rows = await insert(sql`
      insert into "transaction" (account_id, date, amount, amount_base, import_id, category_id, deleted_at)
      values (${pko}, '2026-11-18', -4599, -4599, 'pko-1:E1', ${food}, null),
             (${pko}, '2026-11-19', -100, -100, 'pko-old:E2', null, now()),
             (${pko}, '2026-11-19', -200, -200, null, null, null)
      returning id`);

    await runMigrations(t.db, 'drizzle');
    expect(
      await t.db
        .select({
          importId: bankImport.importId,
          transactionId: bankImport.transactionId,
          autoCategoryId: bankImport.autoCategoryId,
        })
        .from(bankImport)
        .orderBy(asc(bankImport.importId)),
    ).toEqual([
      { importId: `${pko}:E1`, transactionId: rows[0], autoCategoryId: food },
      { importId: `${pko}:E2`, transactionId: rows[1], autoCategoryId: null },
    ]);
  });
});
