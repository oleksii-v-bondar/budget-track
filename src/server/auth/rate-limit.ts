import { and, count, desc, eq, gt, lt } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { loginAttempt } from '../db/schema';
import { AppError } from '../http/errors';

/** Spec §12: 5 login attempts per minute per IP; 10 consecutive failures lock login for 15 minutes. */
export const LOGIN_LIMITS = {
  attemptsPerMinute: 5,
  lockoutAfterFailures: 10,
  lockoutMs: 15 * 60 * 1000,
} as const;

const MINUTE_MS = 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Throws 429 when `ip` has used up its attempts this minute, or while login is locked out. */
export async function assertLoginAllowed(db: Executor, ip: string, now: Date): Promise<void> {
  const [recent] = await db
    .select({ n: count() })
    .from(loginAttempt)
    .where(and(eq(loginAttempt.ip, ip), gt(loginAttempt.at, new Date(now.getTime() - MINUTE_MS))));
  if ((recent?.n ?? 0) >= LOGIN_LIMITS.attemptsPerMinute) {
    throw new AppError(429, 'rate_limited', 'Too many sign-in attempts. Wait a minute and try again.');
  }

  const latest = await db
    .select({ at: loginAttempt.at, success: loginAttempt.success })
    .from(loginAttempt)
    .orderBy(desc(loginAttempt.at), desc(loginAttempt.id))
    .limit(LOGIN_LIMITS.lockoutAfterFailures);
  const lockedOut =
    latest.length === LOGIN_LIMITS.lockoutAfterFailures &&
    latest.every((attempt) => !attempt.success) &&
    now.getTime() - latest[0]!.at.getTime() < LOGIN_LIMITS.lockoutMs;
  if (lockedOut) {
    throw new AppError(429, 'locked', 'Too many failed sign-ins. Try again in 15 minutes.');
  }
}

export async function recordLoginAttempt(db: Executor, ip: string, success: boolean, now: Date): Promise<void> {
  await db.insert(loginAttempt).values({ ip, success, at: now });
  await db.delete(loginAttempt).where(lt(loginAttempt.at, new Date(now.getTime() - RETENTION_MS)));
}
