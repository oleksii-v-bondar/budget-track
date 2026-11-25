import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  type AddToBudgetResponse,
  bankAccountParamSchema,
  type BankListResponse,
  type BankStatus,
  type BankSyncResponse,
  linkBankAccountRequestSchema,
} from '../../shared/api/bank';
import { idParamSchema } from '../../shared/api/common';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import {
  addToBudget,
  bankStatus,
  completeConnect,
  disconnectBank,
  linkBankAccount,
  listBanks,
  startConnect,
  syncBank,
} from './bank-sync';

const STATE_COOKIE = 'bt_bank_state';
const CONNECT_FAILED = '/settings?bank=error';

/** /api/bank: bank connections through Enable Banking. */
export function bankRoutes(deps: AppDeps) {
  // Lax, not Strict: the cookie has to come back with the bank's cross-site redirect to /callback.
  const stateCookie = { httpOnly: true, secure: deps.config.cookieSecure, sameSite: 'Lax', path: '/api/bank' } as const;

  return (
    new Hono<AuthedEnv>()
      .use('*', requireSession(deps))
      .get('/status', async (c) => c.json<BankStatus>(await bankStatus(deps)))
      .get('/aspsps', async (c) => c.json<BankListResponse>({ aspsps: await listBanks(deps) }))
      // Browser navigations: they end in a redirect (to the bank, or back to Settings), never in a JSON error.
      .get('/connect', async (c) => {
        const state = randomBytes(32).toString('base64url');
        try {
          const url = await startConnect(deps, c.req.query('bank') ?? '', state);
          setCookie(c, STATE_COOKIE, state, { ...stateCookie, maxAge: 15 * 60 });
          return c.redirect(url, 302);
        } catch (err) {
          c.var.logger.warn({ err }, 'bank connect failed');
          return c.redirect(CONNECT_FAILED, 302);
        }
      })
      .get('/callback', async (c) => {
        const expected = getCookie(c, STATE_COOKIE);
        deleteCookie(c, STATE_COOKIE, stateCookie);
        const { code, state, error } = c.req.query();
        try {
          if (!expected || state !== expected) throw new Error('bank connect: the state does not match');
          if (error !== undefined) throw new Error(`bank connect: the bank answered ${error.slice(0, 100)}`);
          if (!code) throw new Error('bank connect: no code');
          await completeConnect(deps, code);
          return c.redirect('/settings', 302);
        } catch (err) {
          c.var.logger.warn({ err }, 'bank connect failed');
          return c.redirect(CONNECT_FAILED, 302);
        }
      })
      .put(
        '/accounts/:uid/link',
        validate('param', bankAccountParamSchema),
        validate('json', linkBankAccountRequestSchema),
        async (c) => {
          await linkBankAccount(deps, c.req.valid('param').uid, c.req.valid('json').accountId);
          return c.json<BankStatus>(await bankStatus(deps));
        },
      )
      .post('/accounts/:uid/create-account', validate('param', bankAccountParamSchema), async (c) => {
        const { name } = await addToBudget(deps, c.req.valid('param').uid);
        return c.json<AddToBudgetResponse>({ name, status: await bankStatus(deps) }, 201);
      })
      .post('/sync', async (c) => c.json<BankSyncResponse>(await syncBank(deps)))
      .delete('/connections/:id', validate('param', idParamSchema), async (c) => {
        await disconnectBank(deps, c.req.valid('param').id);
        return c.json<BankStatus>(await bankStatus(deps));
      })
  );
}
