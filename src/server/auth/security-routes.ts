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
import { type SecondFactor, spentFactor, verifySecondFactor } from './second-factor';
import { encryptSecret } from './secret-box';
import { clearSessionCookie, deleteAllSessions, requireSession } from './sessions';
import { newTotpSecret, totpUri, verifyTotp } from './totp';
import { type AppUser, findUser } from './user';

/** The current password plus a second factor: an authenticator code or a recovery code. */
type Credentials = { currentPassword: string } & SecondFactor;

type ReauthOutcome<T> = { ok: false } | { ok: true; value: T };

/** Settings → Security (spec §11/§12). Every change re-checks the current password; none is undoable. */
export function securityRoutes(deps: AppDeps) {
  /**
   * Checks the current password and second factor the way sign-in does: under the login lock, rate limit and lockout,
   * recording the attempt and using up a recovery code. Runs `apply` in the same transaction only if the check passes.
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
      const factor = await verifySecondFactor(user, credentials, now, deps.config.encryptionKey);
      const ok = passwordOk && factor.ok;
      await recordLoginAttempt(tx, ip, ok, now);
      if (!ok) return { ok: false };

      const spent = spentFactor(user, factor);
      await tx.update(appUser).set(spent).where(eq(appUser.id, user.id));
      return { ok: true, value: await apply(tx, { ...user, ...spent }, now) };
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
      // Checked first, so a typo here can't use up the recovery code below. The client sent the secret, so this check
      // reveals nothing and isn't a sign-in attempt.
      const newStep = await verifyTotp(body.totpSecret, body.totpCode, deps.clock.now());
      if (newStep === null) {
        throw new DomainError('invalid_totp_code', "That code didn't match the new authenticator entry.");
      }
      // The current factor proves who is asking (a recovery code covers a lost phone).
      const credentials = {
        currentPassword: body.currentPassword,
        totpCode: body.currentTotpCode,
        recoveryCode: body.recoveryCode,
      };
      await reauthenticated(deps.clientIp(c), credentials, async (tx, user) => {
        // The confirmation code is used up too, so it can't sign in afterwards.
        const totpLastStep = Math.max(newStep, user.totpLastStep ?? newStep);
        await tx
          .update(appUser)
          .set({ totpSecretEnc: encryptSecret(body.totpSecret, deps.config.encryptionKey), totpLastStep })
          .where(eq(appUser.id, user.id));
        await deleteAllSessions(tx, { exceptId: c.var.session.id });
      });
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
