import { Hono } from 'hono';
import { idParamSchema, type IdResponse } from '../../shared/api/common';
import {
  createTransactionRequestSchema,
  type CreateTransactionResponse,
  deleteTransactionRequestSchema,
  type TransactionDto,
  updateTransactionRequestSchema,
} from '../../shared/api/transactions';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import { runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import {
  createTransaction,
  deleteLabel,
  deleteTransaction,
  editLabel,
  savedLabel,
  updateTransaction,
} from './transaction-commands';
import { getTransaction } from './transaction-queries';

/** /api/transactions (spec §10 "Transactions and related workflows"): every change is one undoable command. */
export function transactionRoutes(deps: AppDeps) {
  const today = () => todayIn(deps.config.timeZone, deps.clock.now());

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .post('/', validate('json', createTransactionRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const saved = await runCommand(deps, savedLabel, (rec) => createTransaction(rec, body, today()));
      if (saved.kind === 'scheduled') {
        return c.json<CreateTransactionResponse>({ kind: 'scheduled', scheduledId: saved.id, date: saved.date }, 201);
      }
      const transaction = await getTransaction(deps.db, saved.id);
      return c.json<CreateTransactionResponse>({ kind: 'transaction', transaction }, 201);
    })
    .get('/:id', validate('param', idParamSchema), async (c) =>
      c.json<TransactionDto>(await getTransaction(deps.db, c.req.valid('param').id)),
    )
    .patch('/:id', validate('param', idParamSchema), validate('json', updateTransactionRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const context = { today: today(), now: deps.clock.now() };
      await runCommand(deps, editLabel, (rec) => updateTransaction(rec, id, body, context));
      return c.json<TransactionDto>(await getTransaction(deps.db, id));
    })
    .delete('/:id', validate('param', idParamSchema), validate('json', deleteTransactionRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const { confirmReconciled } = c.req.valid('json');
      const context = { now: deps.clock.now(), confirmReconciled };
      await runCommand(deps, deleteLabel, (rec) => deleteTransaction(rec, id, context));
      return c.json<IdResponse>({ id });
    });
}
