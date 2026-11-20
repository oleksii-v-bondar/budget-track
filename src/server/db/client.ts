import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
/** The handle passed to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run queries: the pool or an open transaction. */
export type Executor = Db | Tx;

export interface Database {
  db: Db;
  close(): Promise<void>;
}

const INT8_OID = 20;

/** int8 (bigint) arrives as text; money must stay an exact JS integer, so refuse anything beyond 2^53. */
function parseInt8(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`int8 value ${raw} is outside the safe integer range`);
  return value;
}

export function createDatabase(url: string, options: { max?: number } = {}): Database {
  const client = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
    types: {
      int8: { to: INT8_OID, from: [INT8_OID], serialize: (value: number) => String(value), parse: parseInt8 },
    },
  });
  const db = drizzle({ client, schema });
  return { db, close: () => client.end({ timeout: 5 }) };
}
