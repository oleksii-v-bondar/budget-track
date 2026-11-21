import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import {
  type AuthStatus,
  type RecoveryCodesResponse,
  setupRequestSchema,
  setupTotpRequestSchema,
  type TotpSecretResponse,
} from '../../shared/auth';
import { monthIn } from '../clock';
import type { Executor } from '../db/client';
import { isUniqueViolation } from '../db/errors';
import { seedBudget } from '../db/seed';
import { appUser } from '../db/schema';
import type { AppDeps } from '../http/app';
import type { AppEnv } from '../http/env';
import { AppError, DomainError } from '../http/errors';
import { validate } from '../http/validate';
import { hashPassword } from './passwords';
import { recordLoginAttempt, withLoginLock } from './rate-limit';
import { generateRecoveryCodes, hashRecoveryCodes } from './recovery-codes';
import { encryptSecret } from './secret-box';
import { createSession, refreshSession, setSessionCookie } from './sessions';
import { newTotpSecret, totpUri, verifyTotp } from './totp';

export async function isSetupComplete(db: Executor): Promise<boolean> {
  const rows = await db.select({ id: appUser.id }).from(appUser).limit(1);
  return rows.length > 0;
}

/** Constant-time comparison (hashing first makes the lengths equal). */
function tokensMatch(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

const alreadySetUp = () => new AppError(409, 'already_setup', 'This budget is already set up. Sign in instead.');

/** Spec §12 first-run setup: only while no user exists, and only with SETUP_TOKEN from the environment. */
export function setupRoutes(deps: AppDeps) {
  async function assertSetupAllowed(ip: string, setupToken: string): Promise<void> {
    if (await isSetupComplete(deps.db)) throw alreadySetUp();
    // A wrong token counts as a failed sign-in, so the sign-in rate limit and lockout (spec §12) also stop guessing.
    const matches = await withLoginLock(deps.db, deps.clock, ip, async (tx, now) => {
      const ok = tokensMatch(setupToken, deps.config.setupToken);
      if (!ok) await recordLoginAttempt(tx, ip, false, now);
      return ok;
    });
    if (!matches) throw new AppError(403, 'invalid_setup_token', 'That setup token is not correct.');
  }

  return new Hono<AppEnv>()
    .get('/status', async (c) => {
      const setupRequired = !(await isSetupComplete(deps.db));
      // Also keeps the cookie's lifetime sliding while the app only polls its status, and clears a stale cookie.
      const authenticated = (await refreshSession(c, deps)) !== null && !setupRequired;
      return c.json<AuthStatus>({ setupRequired, authenticated });
    })
    .post('/setup/totp', validate('json', setupTotpRequestSchema), async (c) => {
      await assertSetupAllowed(deps.clientIp(c), c.req.valid('json').setupToken);
      const secret = newTotpSecret();
      return c.json<TotpSecretResponse>({ secret, uri: totpUri(secret) });
    })
    .post('/setup', validate('json', setupRequestSchema), async (c) => {
      const body = c.req.valid('json');
      await assertSetupAllowed(deps.clientIp(c), body.setupToken);
      const now = deps.clock.now();
      const totpStep = await verifyTotp(body.totpSecret, body.totpCode, now);
      if (totpStep === null) {
        throw new DomainError(
          'invalid_totp_code',
          "That code didn't match. Check that your phone's clock is correct and try again.",
        );
      }
      const recoveryCodes = generateRecoveryCodes();
      const [passwordHash, recoveryCodeHashes] = await Promise.all([
        hashPassword(body.password),
        hashRecoveryCodes(recoveryCodes),
      ]);
      let token: string;
      try {
        // The session is created in the same transaction so a failure can't leave an owner who never saw the codes.
        token = await deps.db.transaction(async (tx) => {
          await tx.insert(appUser).values({
            passwordHash,
            totpSecretEnc: encryptSecret(body.totpSecret, deps.config.encryptionKey),
            recoveryCodeHashes,
            // The confirmation code can't be used again to sign in.
            totpLastStep: totpStep,
            budgetStartMonth: `${monthIn(deps.config.timeZone, now)}-01`,
          });
          await seedBudget(tx);
          return (await createSession(tx, now, c.req.header('user-agent'))).token;
        });
      } catch (error) {
        // Two setups racing: the singleton index lets only one win.
        if (isUniqueViolation(error)) throw alreadySetUp();
        throw error;
      }
      setSessionCookie(c, token, deps.config.cookieSecure);
      return c.json<RecoveryCodesResponse>({ recoveryCodes }, 201);
    });
}
