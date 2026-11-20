import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  changePasswordRequestSchema,
  confirmTotpRequestSchema,
  reauthRequestSchema,
  type RecoveryCodesResponse,
  type TotpSecretResponse,
} from '../../shared/auth';
import type { Tx } from '../db/client';
import { appUser } from '../db/schema';
import type { AppDeps } from '../http/app';
import type { AppEnv } from '../http/env';
import { AppError, DomainError } from '../http/errors';
import { validate } from '../http/validate';
import { hashPassword, verifyPassword } from './passwords';
import { recordLoginAttempt, withLoginLock } from './rate-limit';
import { generateRecoveryCodes, hashRecoveryCodes } from './recovery-codes';
import { decryptSecret, encryptSecret } from './secret-box';
import { clearSessionCookie, deleteAllSessions, requireSession } from './sessions';
import { newTotpSecret, totpUri, verifyTotp } from './totp';
import { type AppUser, findUser } from './user';

interface Credentials {
  currentPassword: string;
  totpCode?: string;
}

type ReauthOutcome<T> = { ok: false } | { ok: true; value: T };

/** Settings → Security (spec §11/§12). Every change re-checks the current password; none is undoable. */
export function securityRoutes(deps: AppDeps) {
  /**
   * Checks the current password (and authenticator code, if given) the way sign-in does: under the login lock, rate
   * limit and lockout, recording the attempt. Runs `apply` in the same transaction only if the check passes.
   */
  async function reauthenticated<T>(
    ip: string,
    credentials: Credentials,
    apply: (tx: Tx, user: AppUser, now: Date) => Promise<T>,
  ): Promise<T> {
    const outcome = await withLoginLock(deps.db, deps.clock, ip, async (tx, now): Promise<ReauthOutcome<T>> => {
      const user = await findUser(tx);
      if (!user) throw new AppError(409, 'setup_required', 'Finish setting up the budget first.');
      const passwordOk = await verifyPassword(user.passwordHash, credentials.currentPassword);
      const codeOk =
        credentials.totpCode === undefined ||
        (await verifyTotp(decryptSecret(user.totpSecretEnc, deps.config.encryptionKey), credentials.totpCode, now));
      const ok = passwordOk && codeOk;
      await recordLoginAttempt(tx, ip, ok, now);
      return ok ? { ok: true, value: await apply(tx, user, now) } : { ok: false };
    });
    // Thrown after commit so the failed attempt stays recorded.
    if (!outcome.ok) throw new DomainError('invalid_credentials', 'Your current password or code is wrong.');
    return outcome.value;
  }

  // Per-route (not .use) so the guard can't leak onto other /api/auth routes mounted at the same prefix.
  const signedIn = requireSession(deps);

  return new Hono<AppEnv>()
    .post('/logout-all', signedIn, async (c) => {
      await deleteAllSessions(deps.db);
      clearSessionCookie(c, deps.config.cookieSecure);
      return c.json({ ok: true as const });
    })
    .post('/password', signedIn, validate('json', changePasswordRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const passwordHash = await hashPassword(body.newPassword);
      await reauthenticated(deps.clientIp(c), body, async (tx, user) => {
        await tx.update(appUser).set({ passwordHash }).where(eq(appUser.id, user.id));
        await deleteAllSessions(tx, { exceptId: c.var.session.id });
      });
      return c.json({ ok: true as const });
    })
    .post('/totp/secret', signedIn, async (c) => {
      const secret = newTotpSecret();
      return c.json<TotpSecretResponse>({ secret, uri: totpUri(secret) });
    })
    .post('/totp', signedIn, validate('json', confirmTotpRequestSchema), async (c) => {
      const body = c.req.valid('json');
      // Only the password is re-checked: `totpCode` belongs to the new secret, and a wrong one isn't a failed sign-in.
      const credentials = { currentPassword: body.currentPassword };
      const confirmed = await reauthenticated(deps.clientIp(c), credentials, async (tx, user, now) => {
        if (!(await verifyTotp(body.totpSecret, body.totpCode, now))) return false;
        await tx
          .update(appUser)
          .set({ totpSecretEnc: encryptSecret(body.totpSecret, deps.config.encryptionKey) })
          .where(eq(appUser.id, user.id));
        return true;
      });
      if (!confirmed) {
        throw new DomainError('invalid_totp_code', "That code didn't match the new authenticator entry.");
      }
      return c.json({ ok: true as const });
    })
    .post('/recovery-codes', signedIn, validate('json', reauthRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const recoveryCodes = generateRecoveryCodes();
      const recoveryCodeHashes = await hashRecoveryCodes(recoveryCodes);
      // Under the login lock, so a concurrent recovery-code sign-in can't write back the old codes over the new ones.
      await reauthenticated(deps.clientIp(c), body, async (tx, user) => {
        await tx.update(appUser).set({ recoveryCodeHashes }).where(eq(appUser.id, user.id));
      });
      return c.json<RecoveryCodesResponse>({ recoveryCodes });
    });
}
