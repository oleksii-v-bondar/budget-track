import { Hono } from 'hono';
import { idParamSchema, type IdResponse } from '../../shared/api/common';
import {
  mergePayeeRequestSchema,
  type PayeeDto,
  type PayeeListResponse,
  payeeNameRequestSchema,
} from '../../shared/api/payees';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { type Named, runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { createPayee, deletePayee, mergePayee, renamePayee } from './payee-commands';
import { getPayee, listPayees } from './payee-queries';

/** /api/payees (spec §10 "Payees"): every change is one undoable command. */
export function payeeRoutes(deps: AppDeps) {
  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/', async (c) => c.json<PayeeListResponse>({ payees: await listPayees(deps.db) }))
    .post('/', validate('json', payeeNameRequestSchema), async (c) => {
      const { name } = c.req.valid('json');
      const { id } = await runCommand(deps, `Create payee "${name}"`, (rec) => createPayee(rec, name));
      return c.json<PayeeDto>(await getPayee(deps.db, id), 201);
    })
    .patch('/:id', validate('param', idParamSchema), validate('json', payeeNameRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const { name } = c.req.valid('json');
      await runCommand(deps, (r: Named) => `Rename payee "${r.name}"`, (rec) => renamePayee(rec, id, name));
      return c.json<PayeeDto>(await getPayee(deps.db, id));
    })
    .post('/:id/merge', validate('param', idParamSchema), validate('json', mergePayeeRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const { targetId } = c.req.valid('json');
      await runCommand(
        deps,
        (r: { name: string; targetName: string }) => `Merge payee "${r.name}" into "${r.targetName}"`,
        (rec) => mergePayee(rec, id, targetId, deps.clock.now()),
      );
      return c.json<PayeeDto>(await getPayee(deps.db, targetId));
    })
    .delete('/:id', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(deps, (r: Named) => `Delete payee "${r.name}"`, (rec) => deletePayee(rec, id, deps.clock.now()));
      return c.json<IdResponse>({ id });
    });
}
