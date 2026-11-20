import { sql } from 'drizzle-orm';
import type { TestProject } from 'vitest/node';
import { createDatabase } from '../db/client';
import { runMigrations } from '../db/migrate';
import { TEMPLATE_DATABASE, withDatabase } from './pg-url';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

/**
 * Starts one Postgres 16 container for the server test run and migrates a template database.
 * Each test file then clones the template (see createTestDatabase), so files run in parallel in isolation.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Docker Desktop's Enhanced Container Isolation forbids Ryuk (it mounts the Docker socket),
  // so the reaper is disabled and the teardown below stops the container.
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  // Without Ryuk nothing else would reap the container, so stop it if the rest of the setup fails.
  try {
    const adminUrl = container.getConnectionUri();

    const admin = createDatabase(adminUrl, { max: 1 });
    try {
      await admin.db.execute(sql.raw(`CREATE DATABASE ${TEMPLATE_DATABASE}`));
    } finally {
      await admin.close();
    }
    const template = createDatabase(withDatabase(adminUrl, TEMPLATE_DATABASE), { max: 1 });
    try {
      await runMigrations(template.db, 'drizzle');
    } finally {
      await template.close();
    }

    project.provide('pgAdminUrl', adminUrl);
  } catch (error) {
    await container.stop();
    throw error;
  }
  return async () => {
    await container.stop();
  };
}
