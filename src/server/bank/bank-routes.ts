import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  bankAccountParamSchema,
  type BankStatus,
  type BankSyncResponse,
  linkBankAccountRequestSchema,
} from '../../shared/api/bank';
import { type AuthedEnv, requireSession } from '../auth/sessions';
import type { AppDeps } from '../http/app';
import { validate } from '../http/validate';
import { bankClient, bankStatus, connectBank, disconnectBank, linkBankAccount, syncBank } from './bank-sync';

const STATE_COOKIE = 'bt_bank_state';

/** /api/bank: bank connections through Mastercard Open Banking (the Aiia Data API). */
export function bankRoutes(deps: AppDeps) {
  // Lax, not Strict: the cookie has to come back with Aiia's cross-site redirect to /callback.
  const stateCookie = { httpOnly: true, secure: deps.config.cookieSecure, sameSite: 'Lax', path: '/api/bank' } as const;

  return new Hono<AuthedEnv>()
    .use('*', requireSession(deps))
    .get('/status', async (c) => c.json<BankStatus>(await bankStatus(deps)))
    .get('/connect', (c) => {
      const state = randomBytes(32).toString('base64url');
      const url = bankClient(deps).connectUrl(state);
      setCookie(c, STATE_COOKIE, state, { ...stateCookie, maxAge: 15 * 60 });
      return c.redirect(url, 302);
    })
    .get('/callback', async (c) => {
      const expected = getCookie(c, STATE_COOKIE);
      deleteCookie(c, STATE_COOKIE, stateCookie);
      const { code, state } = c.req.query();
      try {
        if (!expected || state !== expected) throw new Error('bank connect: the state does not match');
        if (!code) throw new Error('bank connect: no code');
        await connectBank(deps, code);
        return c.redirect('/settings', 302);
      } catch (err) {
        c.var.logger.warn({ err }, 'bank connect failed');
        return c.redirect('/settings?bank=error', 302);
      }
    })
    .put(
      '/accounts/:id/link',
      validate('param', bankAccountParamSchema),
      validate('json', linkBankAccountRequestSchema),
      async (c) => {
        await linkBankAccount(deps, c.req.valid('param').id, c.req.valid('json').accountId);
        return c.json<BankStatus>(await bankStatus(deps));
      },
    )
    .post('/sync', async (c) => c.json<BankSyncResponse>(await syncBank(deps)))
    .delete('/connection', async (c) => {
      await disconnectBank(deps);
      return c.json<BankStatus>(await bankStatus(deps));
    });
}
