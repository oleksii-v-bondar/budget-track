import { asc, desc, eq } from 'drizzle-orm';
import type { UndoItem, UndoState } from '../../shared/api/undo';
import type { Db, Executor, Tx } from '../db/client';
import { undoEntry } from '../db/schema';
import { AppError } from '../http/errors';
import { type Change, fromImage, pkWhere, RECORDED_TABLES, sameData, toImage } from './recorder';
import { lockCommands } from './run-command';

type Direction = 'undo' | 'redo';

/** The entry Undo would revert (newest done) and the one Redo would reapply (oldest undone). */
export async function historyState(db: Executor): Promise<UndoState> {
  const [undo] = await db
    .select({ label: undoEntry.label })
    .from(undoEntry)
    .where(eq(undoEntry.state, 'done'))
    .orderBy(desc(undoEntry.id))
    .limit(1);
  const [redo] = await db
    .select({ label: undoEntry.label })
    .from(undoEntry)
    .where(eq(undoEntry.state, 'undone'))
    .orderBy(asc(undoEntry.id))
    .limit(1);
  return { undo: undo ?? null, redo: redo ?? null };
}

/**
 * Replays changes one row at a time. Each row must still look exactly as the entry left it (ignoring timestamps);
 * otherwise the whole replay is refused and the transaction rolls back.
 */
async function replay(tx: Tx, changes: Change[], direction: Direction): Promise<void> {
  const ordered = direction === 'undo' ? [...changes].reverse() : changes;
  for (const change of ordered) {
    const table = RECORDED_TABLES[change.table];
    const expected = direction === 'undo' ? change.after : change.before;
    const wanted = direction === 'undo' ? change.before : change.after;
    const where = pkWhere(table, change.pk);
    const [current] = await tx
      .select()
      .from(table as typeof table)
      .where(where)
      .for('update');
    const matches =
      current === undefined ? expected === null : expected !== null && sameData(toImage(table, current), expected);
    if (!matches) {
      const verb = direction === 'undo' ? 'undo' : 'redo';
      throw new AppError(409, 'undo_conflict', `Can't ${verb}: data changed since.`);
    }
    if (wanted === null) await tx.delete(table).where(where);
    else if (current === undefined) await tx.insert(table).values(fromImage(table, wanted) as never);
    else await tx.update(table).set(fromImage(table, wanted) as never).where(where);
  }
}

async function step(db: Db, direction: Direction): Promise<UndoItem> {
  return db.transaction(async (tx) => {
    await lockCommands(tx);
    const [entry] = await tx
      .select()
      .from(undoEntry)
      .where(eq(undoEntry.state, direction === 'undo' ? 'done' : 'undone'))
      .orderBy(direction === 'undo' ? desc(undoEntry.id) : asc(undoEntry.id))
      .limit(1);
    if (!entry) {
      throw direction === 'undo'
        ? new AppError(409, 'nothing_to_undo', 'Nothing to undo.')
        : new AppError(409, 'nothing_to_redo', 'Nothing to redo.');
    }
    await replay(tx, entry.changes as Change[], direction);
    await tx
      .update(undoEntry)
      .set({ state: direction === 'undo' ? 'undone' : 'done' })
      .where(eq(undoEntry.id, entry.id));
    return { label: entry.label };
  });
}

/** Reverts the newest done command: its before images, in reverse order. */
export function undo(db: Db): Promise<UndoItem> {
  return step(db, 'undo');
}

/** Reapplies the most recently undone command: its after images, in order. */
export function redo(db: Db): Promise<UndoItem> {
  return step(db, 'redo');
}
