import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db';
import { runMigrations } from './migrate';
import { undoEntry } from './schema';

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
});
