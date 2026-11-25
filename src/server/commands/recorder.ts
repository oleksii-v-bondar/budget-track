import { and, eq, getTableColumns, getTableName, inArray, is, or, type SQL, sql } from 'drizzle-orm';
import { getTableConfig, type PgColumn, PgTimestamp } from 'drizzle-orm/pg-core';
import type { Tx } from '../db/client';
import {
  account,
  appUser,
  assignment,
  bankImport,
  category,
  categoryGroup,
  loanInterestOverride,
  monthNote,
  payee,
  payeeAlias,
  scheduledSubtransaction,
  scheduledTransaction,
  subtransaction,
  target,
  transaction,
} from '../db/schema';

/** Every table a user command may write, keyed by its SQL name; undo looks tables up here. */
export const RECORDED_TABLES = {
  app_user: appUser,
  account,
  category_group: categoryGroup,
  category,
  assignment,
  target,
  month_note: monthNote,
  payee,
  payee_alias: payeeAlias,
  scheduled_transaction: scheduledTransaction,
  scheduled_subtransaction: scheduledSubtransaction,
  transaction,
  subtransaction,
  loan_interest_override: loanInterestOverride,
  bank_import: bankImport,
} as const;

export type RecordedTableName = keyof typeof RECORDED_TABLES;
export type RecordedTable = (typeof RECORDED_TABLES)[RecordedTableName];
type Row = Record<string, unknown>;

/**
 * A JSON-safe copy of one row, keyed by Drizzle property name. Timestamps are ISO strings (exact: columns have
 * millisecond precision), numerics stay decimal strings, generated columns are left out.
 */
export type RowImage = Record<string, string | number | boolean | null>;

/** One recorded row change (spec §4.5 `undo_entry.changes`); `before` is null for inserts, `after` for deletes. */
export interface Change {
  table: RecordedTableName;
  pk: RowImage;
  before: RowImage | null;
  after: RowImage | null;
}

/** Undo conflict checks skip these: they come from two clocks (Postgres now() and JS) and carry no user data. */
const IGNORED_IN_COMPARISON = new Set(['createdAt', 'updatedAt']);

function columnsOf(table: RecordedTable): Record<string, PgColumn> {
  return getTableColumns(table) as Record<string, PgColumn>;
}

export function tableNameOf(table: RecordedTable): RecordedTableName {
  const name = getTableName(table) as RecordedTableName;
  if (RECORDED_TABLES[name] !== table) throw new Error(`Table ${name} is not recorded for undo`);
  return name;
}

/** Property names of the table's primary key columns. */
export function primaryKeyOf(table: RecordedTable): string[] {
  const columns = Object.entries(columnsOf(table));
  const single = columns.filter(([, column]) => column.primary).map(([key]) => key);
  if (single.length > 0) return single;
  const names = getTableConfig(table).primaryKeys[0]?.columns.map((column) => column.name) ?? [];
  if (names.length === 0) throw new Error(`Table ${getTableName(table)} has no primary key`);
  return names.map((name) => columns.find(([, column]) => column.name === name)![0]);
}

export function toImage(table: RecordedTable, row: Row): RowImage {
  const image: RowImage = {};
  for (const [key, column] of Object.entries(columnsOf(table))) {
    if (column.generated) continue;
    const value = row[key];
    if (value instanceof Date) image[key] = value.toISOString();
    else if (value === null || value === undefined) image[key] = null;
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') image[key] = value;
    else throw new Error(`Column ${key} of ${getTableName(table)} holds a value undo can't record`);
  }
  return image;
}

/** The inverse of toImage: values ready for Drizzle insert/update (ISO strings back to Date for timestamps). */
export function fromImage(table: RecordedTable, image: RowImage): Row {
  const columns = columnsOf(table);
  return Object.fromEntries(
    Object.entries(image).map(([key, value]) => {
      const column = columns[key];
      if (!column) throw new Error(`Unknown column ${key} of ${getTableName(table)}`);
      return [key, value !== null && is(column, PgTimestamp) ? new Date(value as string) : value];
    }),
  );
}

/** True when both images hold the same user data (timestamps excluded). */
export function sameData(a: RowImage, b: RowImage): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => IGNORED_IN_COMPARISON.has(key) || a[key] === b[key]);
}

export function pkWhere(table: RecordedTable, pk: RowImage): SQL {
  const columns = columnsOf(table);
  const values = fromImage(table, pk);
  return and(...Object.entries(values).map(([key, value]) => eq(columns[key]!, value)))!;
}

function pkOf(table: RecordedTable, row: Row): RowImage {
  const image = toImage(table, row);
  return Object.fromEntries(primaryKeyOf(table).map((key) => [key, image[key] ?? null]));
}

/** Matches exactly `rows` by primary key. */
function rowsWhere(table: RecordedTable, rows: Row[]): SQL {
  const keys = primaryKeyOf(table);
  const columns = columnsOf(table);
  if (keys.length === 1) return inArray(columns[keys[0]!]!, rows.map((row) => row[keys[0]!]));
  return or(...rows.map((row) => pkWhere(table, pkOf(table, row))))!;
}

function requireWhere(where: SQL | undefined): SQL {
  // Guards against a forgotten condition turning into a whole-table write.
  if (!where) throw new Error('Recorded updates and deletes need a WHERE condition');
  return where;
}

/**
 * Writes rows inside a command's transaction and records ordered before/after images of every row it touches, so
 * undo/redo can replay them (spec §10 "Undo/redo"). Commands must make every write through it; reads go through `tx`.
 */
export class ChangeRecorder {
  readonly changes: Change[] = [];

  constructor(readonly tx: Tx) {}

  async insert<T extends RecordedTable>(
    table: T,
    values: T['$inferInsert'] | T['$inferInsert'][],
  ): Promise<T['$inferSelect'][]> {
    const list = Array.isArray(values) ? values : [values];
    if (list.length === 0) return [];
    const rows = (await this.tx.insert(table).values(list as never).returning()) as T['$inferSelect'][];
    for (const row of rows) this.record(table, null, row as Row);
    return rows;
  }

  /**
   * Applies `set` (plain values only) to the rows matching `where` whose values actually differ, and returns those
   * rows as updated. Rows that already hold the values are left alone, so a no-op records nothing.
   */
  async update<T extends RecordedTable>(
    table: T,
    where: SQL | undefined,
    set: Partial<T['$inferInsert']>,
  ): Promise<T['$inferSelect'][]> {
    const columns = columnsOf(table);
    const entries = Object.entries(set).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return [];
    const keys = primaryKeyOf(table);
    if (entries.some(([key]) => keys.includes(key))) throw new Error('Recorded updates cannot change primary keys');
    const differs = or(
      ...entries.map(([key, value]) => sql`${columns[key]!} IS DISTINCT FROM ${sql.param(value, columns[key]!)}`),
    );
    const before = (await this.tx
      .select()
      .from(table as RecordedTable)
      .where(and(requireWhere(where), differs))
      .for('update')) as Row[];
    if (before.length === 0) return [];
    const after = (await this.tx
      .update(table)
      .set(set as never)
      .where(rowsWhere(table, before))
      .returning()) as Row[];
    const afterByPk = new Map(after.map((row) => [JSON.stringify(pkOf(table, row)), row]));
    for (const row of before) this.record(table, row, afterByPk.get(JSON.stringify(pkOf(table, row)))!);
    return after as T['$inferSelect'][];
  }

  async delete<T extends RecordedTable>(table: T, where: SQL | undefined): Promise<T['$inferSelect'][]> {
    const rows = (await this.tx.delete(table).where(requireWhere(where)).returning()) as Row[];
    for (const row of rows) this.record(table, row, null);
    return rows as T['$inferSelect'][];
  }

  private record(table: RecordedTable, before: Row | null, after: Row | null): void {
    this.changes.push({
      table: tableNameOf(table),
      pk: pkOf(table, (after ?? before)!),
      before: before && toImage(table, before),
      after: after && toImage(table, after),
    });
  }
}
