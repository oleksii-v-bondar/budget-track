import { sql } from 'drizzle-orm';
import { RECORDED_TABLES } from '../commands/recorder';
import type { Db } from '../db/client';

export type DbSnapshot = Record<string, string[]>;

/**
 * Every row of every undo-recorded table as Postgres renders it (`to_jsonb`), sorted. Comparing two snapshots checks
 * that undo/redo restored the exact database state, timestamps and generated columns included.
 */
export async function snapshot(db: Db): Promise<DbSnapshot> {
  const result: DbSnapshot = {};
  for (const name of Object.keys(RECORDED_TABLES)) {
    const rows = await db.execute<{ row: string }>(
      sql`select to_jsonb(t)::text as row from ${sql.identifier(name)} t order by 1`,
    );
    result[name] = rows.map((r) => r.row);
  }
  return result;
}
