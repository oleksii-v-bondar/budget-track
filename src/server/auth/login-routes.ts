import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { type LoginResponse, loginRequestSchema } from '../../shared/auth';
import { appUser } from '../db/schema';
import type { AppDeps } from '../http/app';
import type { AppEnv } from '../http/env';
import { AppError } from '../http/errors';
import { validate } from '../http/validate';
import { verifyPassword } from './passwords';
import { recordLoginAttempt, withLoginLock } from './rate-limit';
import { assertFactorSent, hasAuthenticator, spentFactor, verifySecondFactor } from './second-factor';
import { clearSessionCookie, createSession, deleteSession, requireSession, setSessionCookie } from './sessions';
import { findUser } from './user';

type LoginOutcome = { ok: false; authenticator: boolean } | { ok: true; token: string; response: LoginResponse };

export function loginRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .post('/login', validate('json', loginRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = deps.clientIp(c);
      const outcome = await withLoginLock(deps.db, deps.clock, ip, async (tx, now): Promise<LoginOutcome> => {
        const user = await findUser(tx);
        if (!user) throw new AppError(409, 'setup_required', 'Finish setting up the budget first.');
        const authenticator = hasAuthenticator(user);
        // Without an authenticator, sign-in takes the password only and ignores any code sent.
        assertFactorSent(user, body);

        // The second factor is checked even after a wrong password, so the response time doesn't reveal the password.
        const passwordOk = await verifyPassword(user.passwordHash, body.password);
        const factor = await verifySecondFactor(user, body, now, deps.config.encryptionKey);
        const ok = passwordOk && factor.ok;
        await recordLoginAttempt(tx, ip, ok, now);
        if (!ok) return { ok: false, authenticator };

        await tx.update(appUser).set(spentFactor(user, factor)).where(eq(appUser.id, user.id));
        const { token } = await createSession(tx, now, c.req.header('user-agent'));
        const recoveryCodesRemaining = factor.remainingRecoveryHashes.length;
        return { ok: true, token, response: { authenticatorEnabled: authenticator, recoveryCodesRemaining } };
      });
      // Thrown after commit so the failed attempt stays recorded.
      if (!outcome.ok) {
        const message = outcome.authenticator ? 'Wrong password or code.' : 'Wrong password.';
        throw new AppError(401, 'invalid_credentials', message);
      }

      setSessionCookie(c, outcome.token, deps.config.cookieSecure);
      return c.json<LoginResponse>(outcome.response);
    })
    .post('/logout', requireSession(deps), async (c) => {
      await deleteSession(deps.db, c.var.session.id);
      clearSessionCookie(c, deps.config.cookieSecure);
      return c.json({ ok: true as const });
    });
}
