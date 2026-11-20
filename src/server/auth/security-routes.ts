import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  changePasswordRequestSchema,
  confirmTotpRequestSchema,
  reauthRequestSchema,
  type RecoveryCodesResponse,
  type TotpSecretResponse,
} from '../../shared/auth';
import { appUser } from '../db/schema';
import type { AppDeps } from '../http/app';
import type { AppEnv } from '../http/env';
import { AppError, DomainError } from '../http/errors';
import { validate } from '../http/validate';
import { LOGIN_LOCK_KEY } from './login-routes';
import { hashPassword, verifyPassword } from './passwords';
import { generateRecoveryCodes, hashRecoveryCodes } from './recovery-codes';
import { decryptSecret, encryptSecret } from './secret-box';
import { clearSessionCookie, deleteAllSessions, requireSession } from './sessions';
import { newTotpSecret, totpUri, verifyTotp } from './totp';
import { type AppUser, findUser } from './user';

const wrongCredentials = () => new DomainError('invalid_credentials', 'Your current password or code is wrong.');

/** Settings → Security (spec §11/§12). Every change re-checks the current password; none is undoable. */
export function securityRoutes(deps: AppDeps) {
  async function owner(): Promise<AppUser> {
    const user = await findUser(deps.db);
    if (!user) throw new AppError(409, 'setup_required', 'Finish setting up the budget first.');
    return user;
  }

  async function reauthenticate(currentPassword: string, totpCode?: string): Promise<AppUser> {
    const user = await owner();
    if (!(await verifyPassword(user.passwordHash, currentPassword))) throw wrongCredentials();
    if (totpCode !== undefined) {
      const secret = decryptSecret(user.totpSecretEnc, deps.config.encryptionKey);
      if (!(await verifyTotp(secret, totpCode, deps.clock.now()))) throw wrongCredentials();
    }
    return user;
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
      const user = await reauthenticate(body.currentPassword, body.totpCode);
      const passwordHash = await hashPassword(body.newPassword);
      await deps.db.transaction(async (tx) => {
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
      const user = await reauthenticate(body.currentPassword);
      if (!(await verifyTotp(body.totpSecret, body.totpCode, deps.clock.now()))) {
        throw new DomainError('invalid_totp_code', "That code didn't match the new authenticator entry.");
      }
      await deps.db
        .update(appUser)
        .set({ totpSecretEnc: encryptSecret(body.totpSecret, deps.config.encryptionKey) })
        .where(eq(appUser.id, user.id));
      return c.json({ ok: true as const });
    })
    .post('/recovery-codes', signedIn, validate('json', reauthRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const user = await reauthenticate(body.currentPassword, body.totpCode);
      const recoveryCodes = generateRecoveryCodes();
      const recoveryCodeHashes = await hashRecoveryCodes(recoveryCodes);
      // Same lock as sign-in, so a concurrent recovery-code sign-in can't write back the old codes over the new ones.
      await deps.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${LOGIN_LOCK_KEY}::bigint)`);
        await tx.update(appUser).set({ recoveryCodeHashes }).where(eq(appUser.id, user.id));
      });
      return c.json<RecoveryCodesResponse>({ recoveryCodes });
    });
}
