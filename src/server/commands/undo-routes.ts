import { Hono } from 'hono';
import type { RedoResponse, UndoResponse, UndoState } from '../../shared/api/undo';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import type { AppDeps } from '../http/app';
import { historyState, redo, undo } from './history';

/** /api/undo (spec §10 "Undo/redo"): GET shows what Undo and Redo would do, POST undoes the newest command. */
export function undoRoutes(deps: AppDeps) {
  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/', async (c) => c.json<UndoState>(await historyState(deps.db)))
    .post('/', async (c) => {
      const undone = await undo(deps.db);
      return c.json<UndoResponse>({ ...(await historyState(deps.db)), undone });
    });
}

/** /api/redo: POST reapplies the most recently undone command. */
export function redoRoutes(deps: AppDeps) {
  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .post('/', async (c) => {
      const redone = await redo(deps.db);
      return c.json<RedoResponse>({ ...(await historyState(deps.db)), redone });
    });
}
