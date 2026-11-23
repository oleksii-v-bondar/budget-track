import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  changePasswordRequestSchema,
  type ConfirmTotpResponse,
  confirmTotpRequestSchema,
  disableTotpRequestSchema,
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
import {
  assertFactorSent,
  hasAuthenticator,
  type SecondFactor,
  spentFactor,
  verifySecondFactor,
} from './second-factor';
import { encryptSecret } from './secret-box';
import { clearSessionCookie, deleteAllSessions, requireSession } from './sessions';
import { newTotpSecret, totpUri, verifyTotp } from './totp';
import { type AppUser, findUser } from './user';

/** The current password, plus (while an authenticator is on) an authenticator code or a recovery code. */
type Credentials = { currentPassword: string } & SecondFactor;

type ReauthOutcome<T> = { ok: false; authenticator: boolean } | { ok: true; value: T };

interface NewRecoveryCodes {
  codes: string[];
  hashes: string[];
}

async function newRecoveryCodes(): Promise<NewRecoveryCodes> {
  const codes = generateRecoveryCodes();
  return { codes, hashes: await hashRecoveryCodes(codes) };
}

const noAuthenticator = () => new DomainError('no_authenticator', 'The authenticator app is off.');

/** Settings → Security (spec §11/§12). Every change re-checks the current password; none is undoable. */
export function securityRoutes(deps: AppDeps) {
  /**
   * Checks the current password, and the second factor while an authenticator is on, the way sign-in does: under the
   * login lock, rate limit and lockout, recording the attempt and using up a recovery code. Runs `apply` in the same
   * transaction only if the check passes. With `requireAuthenticator`, refuses with 422 `no_authenticator` (before
   * checking anything, so it isn't an attempt) while none is on.
   */
  async function reauthenticated<T>(
    ip: string,
    credentials: Credentials,
    apply: (tx: Tx, user: AppUser, now: Date) => Promise<T>,
    { requireAuthenticator = false } = {},
  ): Promise<T> {
    const outcome = await withLoginLock(deps.db, deps.clock, ip, async (tx, now): Promise<ReauthOutcome<T>> => {
      const user = await findUser(tx);
      if (!user) throw new AppError(409, 'setup_required', 'Finish setting up the budget first.');
      const authenticator = hasAuthenticator(user);
      if (requireAuthenticator && !authenticator) throw noAuthenticator();
      assertFactorSent(user, credentials);

      const passwordOk = await verifyPassword(user.passwordHash, credentials.currentPassword);
      const factor = await verifySecondFactor(user, credentials, now, deps.config.encryptionKey);
      const ok = passwordOk && factor.ok;
      await recordLoginAttempt(tx, ip, ok, now);
      if (!ok) return { ok: false, authenticator };

      const spent = spentFactor(user, factor);
      await tx.update(appUser).set(spent).where(eq(appUser.id, user.id));
      return { ok: true, value: await apply(tx, { ...user, ...spent }, now) };
    });
    // Thrown after commit so the failed attempt stays recorded.
    if (!outcome.ok) {
      const what = outcome.authenticator ? 'password or code' : 'password';
      throw new DomainError('invalid_credentials', `Your current ${what} is wrong.`);
    }
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
    // Turns the authenticator on (the password and a code from the new secret; returns ten new recovery codes) or,
    // while one is on, replaces it (also the current code or a recovery code; the recovery codes stay).
    .post('/totp', signedIn, validate('json', confirmTotpRequestSchema), async (c) => {
      const body = c.req.valid('json');
      // Checked first, so a typo here can't use up the recovery code below. The client sent the secret, so this check
      // reveals nothing and isn't a sign-in attempt.
      const newStep = await verifyTotp(body.totpSecret, body.totpCode, deps.clock.now());
      if (newStep === null) {
        throw new DomainError('invalid_totp_code', "That code didn't match the new authenticator entry.");
      }
      // Hashed before taking the login lock when turning it on; only if it was turned off meanwhile is it done inside.
      const owner = await findUser(deps.db);
      const prepared = owner && !hasAuthenticator(owner) ? await newRecoveryCodes() : null;
      // The current factor proves who is asking (a recovery code covers a lost phone).
      const credentials = {
        currentPassword: body.currentPassword,
        totpCode: body.currentTotpCode,
        recoveryCode: body.recoveryCode,
      };
      const recoveryCodes = await reauthenticated(deps.clientIp(c), credentials, async (tx, user) => {
        const turningOn = !hasAuthenticator(user);
        const fresh = turningOn ? (prepared ?? (await newRecoveryCodes())) : null;
        // The confirmation code is used up too, so it can't sign in afterwards.
        const totpLastStep = Math.max(newStep, user.totpLastStep ?? newStep);
        await tx
          .update(appUser)
          .set({
            totpSecretEnc: encryptSecret(body.totpSecret, deps.config.encryptionKey),
            totpLastStep,
            ...(fresh && { recoveryCodeHashes: fresh.hashes }),
          })
          .where(eq(appUser.id, user.id));
        await deleteAllSessions(tx, { exceptId: c.var.session.id });
        return fresh?.codes;
      });
      return c.json<ConfirmTotpResponse>(recoveryCodes ? { ok: true, recoveryCodes } : { ok: true });
    })
    // Turns the authenticator off: sign-in takes the password only again, and the recovery codes are gone.
    .post('/totp/disable', signedIn, validate('json', disableTotpRequestSchema), async (c) => {
      const body = c.req.valid('json');
      await reauthenticated(
        deps.clientIp(c),
        body,
        async (tx, user) => {
          await tx
            .update(appUser)
            .set({ totpSecretEnc: null, recoveryCodeHashes: [], totpLastStep: null })
            .where(eq(appUser.id, user.id));
          await deleteAllSessions(tx, { exceptId: c.var.session.id });
        },
        { requireAuthenticator: true },
      );
      return c.json({ ok: true as const });
    })
    .post('/recovery-codes', signedIn, validate('json', reauthRequestSchema), async (c) => {
      const body = c.req.valid('json');
      // Checked again under the lock; this saves hashing codes that can't be used.
      const owner = await findUser(deps.db);
      if (owner && !hasAuthenticator(owner)) throw noAuthenticator();
      const { codes, hashes } = await newRecoveryCodes();
      // Under the login lock, so a concurrent recovery-code sign-in can't write back the old codes over the new ones.
      await reauthenticated(
        deps.clientIp(c),
        body,
        async (tx, user) => {
          await tx.update(appUser).set({ recoveryCodeHashes: hashes }).where(eq(appUser.id, user.id));
        },
        { requireAuthenticator: true },
      );
      return c.json<RecoveryCodesResponse>({ recoveryCodes: codes });
    });
}
