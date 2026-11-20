import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { undoEntry } from '../db/schema';
import { ChangeRecorder } from './recorder';

/**
 * Advisory lock key that serializes user commands with undo/redo, so a command can't interleave with a replay and
 * the history stays linear. (The login lock is 727274001; keep the keys distinct.)
 */
export const COMMAND_LOCK_KEY = 727274002;

/** Spec §10: only the newest 100 done entries are kept. */
export const UNDO_HISTORY_LIMIT = 100;

export async function lockCommands(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${COMMAND_LOCK_KEY}::bigint)`);
}

/** What commands return when their undo label names the row they changed. */
export interface Named {
  name: string;
}

/**
 * Runs one user command in one transaction (spec §2 write path). `fn` writes through the recorder; if it changed
 * anything, the changes become a new undo entry, the redo stack is cleared and the history is trimmed. A command
 * that changes nothing leaves the history (including redo) alone.
 */
export function runCommand<T>(
  deps: { db: Db },
  /** A function gets the command's result, e.g. `(r: Named) => \`Delete account "${r.name}"\``. */
  label: string | ((result: T) => string),
  fn: (rec: ChangeRecorder) => Promise<T>,
): Promise<T> {
  return deps.db.transaction(async (tx) => {
    await lockCommands(tx);
    const rec = new ChangeRecorder(tx);
    const result = await fn(rec);
    if (rec.changes.length > 0) {
      await tx.delete(undoEntry).where(eq(undoEntry.state, 'undone'));
      await tx.insert(undoEntry).values({
        label: typeof label === 'function' ? label(result) : label,
        changes: rec.changes,
      });
      const kept = tx
        .select({ id: undoEntry.id })
        .from(undoEntry)
        .where(eq(undoEntry.state, 'done'))
        .orderBy(desc(undoEntry.id))
        .limit(UNDO_HISTORY_LIMIT);
      await tx.delete(undoEntry).where(and(eq(undoEntry.state, 'done'), notInArray(undoEntry.id, kept)));
    }
    return result;
  });
}
