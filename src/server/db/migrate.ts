import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client';

/** Applies all pending SQL migrations from `migrationsFolder` (idempotent). */
export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
