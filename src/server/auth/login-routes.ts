import { eq } from 'drizzle-orm';
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

export function loginRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .post('/login', validate('json', loginRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = deps.clientIp(c);
      const now = deps.clock.now();
      await assertLoginAllowed(deps.db, ip, now);

      const user = await findUser(deps.db);
      if (!user) throw new AppError(409, 'setup_required', 'Finish setting up the budget first.');

      let ok = await verifyPassword(user.passwordHash, body.password);
      let recoveryCodeHashes = user.recoveryCodeHashes;
      if (ok && body.totpCode !== undefined) {
        ok = await verifyTotp(decryptSecret(user.totpSecretEnc, deps.config.encryptionKey), body.totpCode, now);
      } else if (ok && body.recoveryCode !== undefined) {
        const remaining = await consumeRecoveryCode(user.recoveryCodeHashes, body.recoveryCode);
        ok = remaining !== null;
        if (remaining) {
          recoveryCodeHashes = remaining;
          await deps.db.update(appUser).set({ recoveryCodeHashes: remaining }).where(eq(appUser.id, user.id));
        }
      }
      await recordLoginAttempt(deps.db, ip, ok, now);
      if (!ok) throw new AppError(401, 'invalid_credentials', 'Wrong password or code.');

      const { token } = await createSession(deps.db, now, c.req.header('user-agent'));
      setSessionCookie(c, token, deps.config.cookieSecure);
      return c.json<LoginResponse>({ recoveryCodesRemaining: recoveryCodeHashes.length });
    })
    .post('/logout', requireSession(deps), async (c) => {
      await deleteSession(deps.db, c.var.session.id);
      clearSessionCookie(c, deps.config.cookieSecure);
      return c.json({ ok: true as const });
    });
}
