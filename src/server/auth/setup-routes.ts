import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { type AuthStatus, setupRequestSchema } from '../../shared/auth';
import { monthIn } from '../clock';
import type { Executor } from '../db/client';
import { isUniqueViolation } from '../db/errors';
import { seedBudget } from '../db/seed';
import { appUser } from '../db/schema';
import type { AppDeps } from '../http/app';
import type { AppEnv } from '../http/env';
import { AppError } from '../http/errors';
import { validate } from '../http/validate';
import { hashPassword } from './passwords';
import { recordLoginAttempt, withLoginLock } from './rate-limit';
import { hasAuthenticator } from './second-factor';
import { createSession, refreshSession, setSessionCookie } from './sessions';
import { findUser } from './user';

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

/**
 * Spec §12 first-run setup: only while no user exists, and only with SETUP_TOKEN from the environment. It sets the
 * password; the authenticator app stays off until the owner turns it on in Settings.
 */
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
      const user = await findUser(deps.db);
      const setupRequired = user === null;
      // Also keeps the cookie's lifetime sliding while the app only polls its status, and clears a stale cookie.
      const authenticated = (await refreshSession(c, deps)) !== null && !setupRequired;
      // Public, so the sign-in page knows whether to ask for a code (a single-user app: this reveals little).
      const authenticatorEnabled = user !== null && hasAuthenticator(user);
      return c.json<AuthStatus>({ setupRequired, authenticated, authenticatorEnabled });
    })
    .post('/setup', validate('json', setupRequestSchema), async (c) => {
      const body = c.req.valid('json');
      await assertSetupAllowed(deps.clientIp(c), body.setupToken);
      const now = deps.clock.now();
      const passwordHash = await hashPassword(body.password);
      let token: string;
      try {
        // One transaction: a failure (even creating the session) leaves nothing behind, so setup can run again.
        token = await deps.db.transaction(async (tx) => {
          // No authenticator: totp_secret_enc, the recovery codes and totp_last_step keep their defaults.
          await tx.insert(appUser).values({
            passwordHash,
            budgetStartMonth: `${monthIn(deps.config.timeZone, now)}-01`,
          });
          await seedBudget(tx);
          // Ends the streak of failures: wrong setup tokens before it don't count toward the first sign-ins' lockout.
          await recordLoginAttempt(tx, deps.clientIp(c), true, now);
          return (await createSession(tx, now, c.req.header('user-agent'))).token;
        });
      } catch (error) {
        // Two setups racing: the singleton index lets only one win.
        if (isUniqueViolation(error)) throw alreadySetUp();
        throw error;
      }
      setSessionCookie(c, token, deps.config.cookieSecure);
      return c.json({ ok: true as const }, 201);
    });
}
