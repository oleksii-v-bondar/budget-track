import { Hono } from 'hono';
import { idParamSchema, type IdResponse } from '../../shared/api/common';
import {
  type BulkResponse,
  bulkRequestSchema,
  createTransactionRequestSchema,
  type CreateTransactionResponse,
  deleteTransactionRequestSchema,
  type RegisterResponse,
  registerQuerySchema,
  type TransactionDto,
  updateTransactionRequestSchema,
  type UpdateTransactionResponse,
} from '../../shared/api/transactions';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import { runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { bulkLabel, bulkUpdate } from './bulk';
import { createDefaultRates, editDefaultRates } from './default-rates';
import {
  createTransaction,
  deleteLabel,
  deleteTransaction,
  editLabel,
  savedLabel,
  updateTransaction,
} from './transaction-commands';
import { getTransaction, listRegister } from './transaction-queries';

/** /api/transactions (spec §10 "Transactions and related workflows"): every change is one undoable command. */
export function transactionRoutes(deps: AppDeps) {
  const today = () => todayIn(deps.config.timeZone, deps.clock.now());

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/', validate('query', registerQuerySchema), async (c) => {
      const query = c.req.valid('query');
      // One read-only snapshot, so the balances match the rows.
      const page = await deps.db.transaction((tx) => listRegister(tx, query), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
      return c.json<RegisterResponse>(page);
    })
    .post('/', validate('json', createTransactionRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const now = today();
      // Spec §9: NBP rates are quoted before the command, outside its transaction.
      const defaults = await createDefaultRates(deps, body, now);
      const saved = await runCommand(deps, savedLabel, (rec) => createTransaction(rec, body, now, defaults));
      if (saved.kind === 'scheduled') {
        return c.json<CreateTransactionResponse>({ kind: 'scheduled', scheduledId: saved.id, date: saved.date }, 201);
      }
      const transaction = await getTransaction(deps.db, saved.id);
      return c.json<CreateTransactionResponse>({ kind: 'transaction', transaction }, 201);
    })
    .post('/bulk', validate('json', bulkRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const context = { today: today(), now: deps.clock.now() };
      await runCommand(deps, bulkLabel(body), (rec) => bulkUpdate(rec, body, context));
      return c.json<BulkResponse>({ ids: body.ids });
    })
    .get('/:id', validate('param', idParamSchema), async (c) =>
      c.json<TransactionDto>(await getTransaction(deps.db, c.req.valid('param').id)),
    )
    .patch('/:id', validate('param', idParamSchema), validate('json', updateTransactionRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const context = { today: today(), now: deps.clock.now() };
      const defaults = await editDefaultRates(deps, id, body, context.today);
      const { linkedTo } = await runCommand(deps, editLabel, (rec) =>
        updateTransaction(rec, id, body, { ...context, defaults }),
      );
      return c.json<UpdateTransactionResponse>({ ...(await getTransaction(deps.db, id)), linkedTo });
    })
    .delete('/:id', validate('param', idParamSchema), validate('json', deleteTransactionRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const { confirmReconciled } = c.req.valid('json');
      const context = { now: deps.clock.now(), confirmReconciled };
      await runCommand(deps, deleteLabel, (rec) => deleteTransaction(rec, id, context));
      return c.json<IdResponse>({ id });
    });
}
