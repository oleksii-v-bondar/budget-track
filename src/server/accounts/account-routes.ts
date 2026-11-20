import { Hono } from 'hono';
import {
  type AccountDto,
  type AccountListResponse,
  createAccountRequestSchema,
  updateAccountRequestSchema,
} from '../../shared/api/accounts';
import { idParamSchema, type IdResponse, type ReorderResponse, reorderRequestSchema } from '../../shared/api/common';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import { type Named, runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { createAccount, deleteAccount, reorderAccounts, setAccountClosed, updateAccount } from './account-commands';
import { getAccount, listAccounts } from './account-queries';

/** /api/accounts (spec §10 "Accounts"): every change is one undoable command. */
export function accountRoutes(deps: AppDeps) {
  const today = () => todayIn(deps.config.timeZone, deps.clock.now());

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/', async (c) => c.json<AccountListResponse>({ accounts: await listAccounts(deps.db) }))
    .post('/', validate('json', createAccountRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const { id } = await runCommand(deps, `Create account "${body.name}"`, (rec) =>
        createAccount(rec, body, today()),
      );
      return c.json<AccountDto>(await getAccount(deps.db, id), 201);
    })
    .put('/order', validate('json', reorderRequestSchema), async (c) => {
      const { ids } = c.req.valid('json');
      await runCommand(deps, 'Reorder accounts', (rec) => reorderAccounts(rec, ids));
      return c.json<ReorderResponse>({ ids });
    })
    .patch('/:id', validate('param', idParamSchema), validate('json', updateAccountRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      await runCommand(deps, (r: Named) => `Edit account "${r.name}"`, (rec) => updateAccount(rec, id, body));
      return c.json<AccountDto>(await getAccount(deps.db, id));
    })
    .post('/:id/close', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(
        deps,
        (r: Named) => `Close account "${r.name}"`,
        (rec) => setAccountClosed(rec, id, true, today()),
      );
      return c.json<AccountDto>(await getAccount(deps.db, id));
    })
    .post('/:id/reopen', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(
        deps,
        (r: Named) => `Reopen account "${r.name}"`,
        (rec) => setAccountClosed(rec, id, false, today()),
      );
      return c.json<AccountDto>(await getAccount(deps.db, id));
    })
    .delete('/:id', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(deps, (r: Named) => `Delete account "${r.name}"`, (rec) => deleteAccount(rec, id));
      return c.json<IdResponse>({ id });
    });
}
