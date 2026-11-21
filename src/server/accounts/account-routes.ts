import { Hono } from 'hono';
import {
  type AccountDto,
  type AccountListResponse,
  BASE_CURRENCY,
  createAccountRequestSchema,
  type ReconcileResponse,
  type ReconcileStatusDto,
  reconcileRequestSchema,
  revalueRequestSchema,
  type RevalueResponse,
  updateAccountRequestSchema,
} from '../../shared/api/accounts';
import { idParamSchema, type IdResponse, type ReorderResponse, reorderRequestSchema } from '../../shared/api/common';
import { interestOverrideRequestSchema, type LoanDto, loanMonthParamSchema } from '../../shared/api/loans';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import { todayIn } from '../clock';
import { type Named, runCommand } from '../commands/run-command';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { deleteInterestOverride, getLoan, setInterestOverride } from '../loans/loan-commands';
import { getTransaction } from '../transactions/transaction-queries';
import { createAccount, deleteAccount, reorderAccounts, setAccountClosed, updateAccount } from './account-commands';
import { getAccount, readAccount, readAccounts } from './account-queries';
import { reconcileAccount, reconcileStatus } from './reconcile';
import { revalueAccount } from './revalue';

/**
 * /api/accounts (spec §10 "Accounts", §9): every change is one undoable command. Account DTOs carry "≈ X zł" at
 * the latest NBP rate, quoted after the command (see `readAccounts`).
 */
export function accountRoutes(deps: AppDeps) {
  const today = () => todayIn(deps.config.timeZone, deps.clock.now());

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/', async (c) => c.json<AccountListResponse>({ accounts: await readAccounts(deps, today()) }))
    .post('/', validate('json', createAccountRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const now = today();
      const date = body.startingDate ?? now;
      // Spec §9: the NBP rate is quoted before the command, outside its transaction.
      const needsRate = body.currency !== BASE_CURRENCY && body.fxRate === undefined && date <= now;
      const nbp = needsRate ? await deps.fx.quote(body.currency, date) : null;
      const { id } = await runCommand(deps, `Create account "${body.name}"`, (rec) =>
        createAccount(rec, body, now, nbp),
      );
      return c.json<AccountDto>(await readAccount(deps, now, id), 201);
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
      return c.json<AccountDto>(await readAccount(deps, today(), id));
    })
    .post('/:id/close', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(
        deps,
        (r: Named) => `Close account "${r.name}"`,
        (rec) => setAccountClosed(rec, id, true, today()),
      );
      return c.json<AccountDto>(await readAccount(deps, today(), id));
    })
    .post('/:id/reopen', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(
        deps,
        (r: Named) => `Reopen account "${r.name}"`,
        (rec) => setAccountClosed(rec, id, false, today()),
      );
      return c.json<AccountDto>(await readAccount(deps, today(), id));
    })
    .post('/:id/revalue', validate('param', idParamSchema), validate('json', revalueRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const { fxRate } = c.req.valid('json');
      const now = today();
      // Spec §9: the latest NBP rate is quoted before the command, outside its transaction.
      const { currency } = await getAccount(deps.db, id);
      const nbp = fxRate === undefined && currency !== BASE_CURRENCY ? await deps.fx.quote(currency, now) : null;
      const rate = fxRate === undefined ? nbp && { rate: nbp.rate, manual: false } : { rate: fxRate, manual: true };
      const { transactionId } = await runCommand(
        deps,
        (r: Named) => `Revalue "${r.name}"`,
        (rec) => revalueAccount(rec, id, rate, now),
      );
      return c.json<RevalueResponse>({
        account: await readAccount(deps, now, id),
        transaction: await getTransaction(deps.db, transactionId),
      });
    })
    .get('/:id/reconcile', validate('param', idParamSchema), async (c) =>
      c.json<ReconcileStatusDto>(await reconcileStatus(deps.db, c.req.valid('param').id)),
    )
    .post('/:id/reconcile', validate('param', idParamSchema), validate('json', reconcileRequestSchema), async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const now = today();
      // Spec §9: a foreign adjustment's NBP rate is quoted before the command, and only when one will be needed.
      const current = await getAccount(deps.db, id);
      const defaults = new Map<string, string>();
      const adjusts = body.createAdjustment && current.balance.cleared !== body.statementBalance;
      if (adjusts && body.fxRate === undefined && current.currency !== BASE_CURRENCY) {
        const nbp = await deps.fx.quote(current.currency, now);
        if (nbp) defaults.set(current.currency, nbp.rate);
      }
      const result = await runCommand(
        deps,
        (r: Named) => `Reconcile "${r.name}"`,
        (rec) => reconcileAccount(rec, id, body, { today: now, now: deps.clock.now(), defaults }),
      );
      return c.json<ReconcileResponse>({
        ...(await reconcileStatus(deps.db, id)),
        adjustment: result.adjustmentId === null ? null : await getTransaction(deps.db, result.adjustmentId),
        reconciledCount: result.reconciledCount,
      });
    })
    .get('/:id/loan', validate('param', idParamSchema), async (c) =>
      c.json<LoanDto>(await getLoan(deps.db, c.req.valid('param').id)),
    )
    .put(
      '/:id/interest-overrides/:month',
      validate('param', loanMonthParamSchema),
      validate('json', interestOverrideRequestSchema),
      async (c) => {
        const { id, month } = c.req.valid('param');
        const { amount } = c.req.valid('json');
        await runCommand(
          deps,
          (r: Named) => `Set the interest of "${r.name}" for ${month}`,
          (rec) => setInterestOverride(rec, id, month, amount, today()),
        );
        return c.json<LoanDto>(await getLoan(deps.db, id));
      },
    )
    .delete('/:id/interest-overrides/:month', validate('param', loanMonthParamSchema), async (c) => {
      const { id, month } = c.req.valid('param');
      await runCommand(
        deps,
        (r: Named) => `Reset the interest of "${r.name}" for ${month}`,
        (rec) => deleteInterestOverride(rec, id, month),
      );
      return c.json<LoanDto>(await getLoan(deps.db, id));
    })
    .delete('/:id', validate('param', idParamSchema), async (c) => {
      const { id } = c.req.valid('param');
      await runCommand(deps, (r: Named) => `Delete account "${r.name}"`, (rec) => deleteAccount(rec, id));
      return c.json<IdResponse>({ id });
    });
}
