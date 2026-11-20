import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { inject } from 'vitest';
import { createDatabase, type Db } from '../db/client';
import { TEMPLATE_DATABASE, withDatabase } from './pg-url';

export interface TestDatabase {
  db: Db;
  url: string;
  /** Closes connections and drops the database. */
  drop(): Promise<void>;
}

async function admin(statement: string): Promise<void> {
  const database = createDatabase(inject('pgAdminUrl'), { max: 1 });
  try {
    await database.db.execute(sql.raw(statement));
  } finally {
    await database.close();
  }
}

/**
 * A fresh, fully migrated database cloned from the template created in global-setup; `empty: true` skips the
 * migrations (for testing them).
 */
export async function createTestDatabase(options: { empty?: boolean } = {}): Promise<TestDatabase> {
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  await admin(options.empty ? `CREATE DATABASE ${name}` : `CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`);
  const url = withDatabase(inject('pgAdminUrl'), name);
  const database = createDatabase(url, { max: 5 });
  return {
    db: database.db,
    url,
    async drop() {
      await database.close();
      await admin(`DROP DATABASE ${name} WITH (FORCE)`);
    },
  };
}
