import { Hono } from 'hono';
import { type AccountDto, type AccountListResponse, createAccountRequestSchema } from '../../shared/api/accounts';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import { runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { createAccount } from './account-commands';
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
    });
}
