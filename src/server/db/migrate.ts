import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client';
import { undoEntry } from './schema';

/** How many migrations the database has applied; 0 before the first run, when drizzle's table doesn't exist yet. */
async function appliedMigrations(db: Db): Promise<number> {
  const [table] = await db.execute<{ present: boolean }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
  );
  if (!table?.present) return 0;
  const [row] = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
  );
  return row!.count;
}

/**
 * Applies all pending SQL migrations from `migrationsFolder` (idempotent). Applying any clears the undo history: its
 * row images describe the old schema, so replaying them could fail or write wrong data.
 */
export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
  const before = await appliedMigrations(db);
  await migrate(db, { migrationsFolder });
  if ((await appliedMigrations(db)) > before) await db.delete(undoEntry);
}
