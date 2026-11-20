import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { loginRequestSchema } from '../../shared/auth';
import { appUser } from '../db/schema';
import type { AppDeps } from '../http/app';
import type { AppEnv } from '../http/env';
import { AppError } from '../http/errors';
import { validate } from '../http/validate';
import { verifyPassword } from './passwords';
import { assertLoginAllowed, recordLoginAttempt } from './rate-limit';
import { consumeRecoveryCode } from './recovery-codes';
import { decryptSecret } from './secret-box';
import { clearSessionCookie, createSession, deleteSession, requireSession, setSessionCookie } from './sessions';
import { verifyTotp } from './totp';
import { findUser } from './user';

export interface LoginResponse {
  /** How many unused recovery codes are left (the UI warns when it gets low). */
  recoveryCodesRemaining: number;
}

/**
 * Key for the transaction-scoped advisory lock that serializes sign-ins. Without it, parallel requests could all pass
 * the rate-limit and lockout checks before any attempt is recorded, or spend the same recovery code twice.
 */
const LOGIN_LOCK_KEY = 727274001;

type LoginOutcome = { ok: false } | { ok: true; token: string; remaining: number };

export function loginRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .post('/login', validate('json', loginRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = deps.clientIp(c);
      const outcome = await deps.db.transaction(async (tx): Promise<LoginOutcome> => {
        await tx.execute(sql`select pg_advisory_xact_lock(${LOGIN_LOCK_KEY}::bigint)`);
        const now = deps.clock.now();
        await assertLoginAllowed(tx, ip, now);

        const user = await findUser(tx);
        if (!user) throw new AppError(409, 'setup_required', 'Finish setting up the budget first.');

        // The second factor is checked even after a wrong password, so the response time doesn't reveal the password.
        const passwordOk = await verifyPassword(user.passwordHash, body.password);
        let secondFactorOk = false;
        let recoveryCodeHashes = user.recoveryCodeHashes;
        if (body.totpCode !== undefined) {
          secondFactorOk = await verifyTotp(
            decryptSecret(user.totpSecretEnc, deps.config.encryptionKey),
            body.totpCode,
            now,
          );
        } else if (body.recoveryCode !== undefined) {
          const remaining = await consumeRecoveryCode(user.recoveryCodeHashes, body.recoveryCode);
          secondFactorOk = remaining !== null;
          if (passwordOk && remaining) {
            recoveryCodeHashes = remaining;
            await tx.update(appUser).set({ recoveryCodeHashes: remaining }).where(eq(appUser.id, user.id));
          }
        }
        const ok = passwordOk && secondFactorOk;
        await recordLoginAttempt(tx, ip, ok, now);
        if (!ok) return { ok: false };

        const { token } = await createSession(tx, now, c.req.header('user-agent'));
        return { ok: true, token, remaining: recoveryCodeHashes.length };
      });
      // Thrown after commit so the failed attempt stays recorded.
      if (!outcome.ok) throw new AppError(401, 'invalid_credentials', 'Wrong password or code.');

      setSessionCookie(c, outcome.token, deps.config.cookieSecure);
      return c.json<LoginResponse>({ recoveryCodesRemaining: outcome.remaining });
    })
    .post('/logout', requireSession(deps), async (c) => {
      await deleteSession(deps.db, c.var.session.id);
      clearSessionCookie(c, deps.config.cookieSecure);
      return c.json({ ok: true as const });
    });
}
