import { and, count, desc, eq, gt, lt, min, sql } from 'drizzle-orm';
import type { Clock } from '../clock';
import type { Db, Executor, Tx } from '../db/client';
import { isLockTimeout } from '../db/errors';
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

/** A 429 that tells the client, in a `Retry-After` header, how many seconds until `until`. */
function tooMany(code: string, message: string, until: number, now: Date): AppError {
  const seconds = Math.max(1, Math.ceil((until - now.getTime()) / 1000));
  return new AppError(429, code, message, {}, { 'Retry-After': String(seconds) });
}

/** Throws 429 when `ip` has used up its attempts this minute, or while login is locked out. */
export async function assertLoginAllowed(db: Executor, ip: string, now: Date): Promise<void> {
  const [recent] = await db
    .select({ n: count(), oldest: min(loginAttempt.at) })
    .from(loginAttempt)
    .where(and(eq(loginAttempt.ip, ip), gt(loginAttempt.at, new Date(now.getTime() - MINUTE_MS))));
  if (recent?.oldest && recent.n >= LOGIN_LIMITS.attemptsPerMinute) {
    // A slot frees up when the oldest attempt of the last minute is a minute old.
    const message = 'Too many sign-in attempts. Wait a minute and try again.';
    throw tooMany('rate_limited', message, recent.oldest.getTime() + MINUTE_MS, now);
  }

  const latest = await db
    .select({ at: loginAttempt.at, success: loginAttempt.success })
    .from(loginAttempt)
    .orderBy(desc(loginAttempt.at), desc(loginAttempt.id))
    .limit(LOGIN_LIMITS.lockoutAfterFailures);
  const lockedUntil = latest[0] ? latest[0].at.getTime() + LOGIN_LIMITS.lockoutMs : 0;
  const lockedOut =
    latest.length === LOGIN_LIMITS.lockoutAfterFailures &&
    latest.every((attempt) => !attempt.success) &&
    now.getTime() < lockedUntil;
  if (lockedOut) {
    throw tooMany('locked', 'Too many failed sign-ins. Try again in 15 minutes.', lockedUntil, now);
  }
}

export async function recordLoginAttempt(db: Executor, ip: string, success: boolean, now: Date): Promise<void> {
  await db.insert(loginAttempt).values({ ip, success, at: now });
  await db.delete(loginAttempt).where(lt(loginAttempt.at, new Date(now.getTime() - RETENTION_MS)));
}

/**
 * Key for the transaction-scoped advisory lock that serializes sign-ins and re-authentication. Without it, parallel
 * requests could all pass the rate-limit and lockout checks before any attempt is recorded, or spend the same recovery
 * code twice. Regenerating recovery codes holds it too, so a sign-in can't write back the old codes.
 */
export const LOGIN_LOCK_KEY = 727274001;

/** How long a sign-in waits for another process's login lock before answering 503 `busy`. */
export const LOGIN_LOCK_TIMEOUT_MS = 5000;

/** The tail of each database's queue of sign-ins in this process (see withLoginLock). */
const loginQueues = new WeakMap<Db, Promise<unknown>>();

/** Runs `fn` once every earlier call for the same database has settled. */
function inTurn<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const turn = (loginQueues.get(db) ?? Promise.resolve()).then(fn);
  loginQueues.set(
    db,
    turn.catch(() => undefined),
  );
  return turn;
}

/**
 * Runs `fn` in a transaction that holds the login lock, once `ip` has passed the rate limit and lockout checks.
 * `fn` checks the credentials and records the attempt; a failure should be returned, not thrown, so it stays recorded.
 *
 * Sign-ins in this process wait their turn in memory first, so waiting ones don't hold pooled connections (a burst of
 * sign-ins could otherwise starve every other request). The advisory lock still guards against other processes; a
 * wait for it longer than `lockTimeoutMs` gives up with 503 `busy`.
 */
export function withLoginLock<T>(
  db: Db,
  clock: Clock,
  ip: string,
  fn: (tx: Tx, now: Date) => Promise<T>,
  options: { lockTimeoutMs?: number } = {},
): Promise<T> {
  const lockTimeout = `${options.lockTimeoutMs ?? LOGIN_LOCK_TIMEOUT_MS}ms`;
  return inTurn(db, async () => {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('lock_timeout', ${lockTimeout}, true)`);
        await tx.execute(sql`select pg_advisory_xact_lock(${LOGIN_LOCK_KEY}::bigint)`);
        const now = clock.now();
        await assertLoginAllowed(tx, ip, now);
        return fn(tx, now);
      });
    } catch (error) {
      if (!isLockTimeout(error)) throw error;
      throw new AppError(503, 'busy', 'Signing in is busy. Try again in a moment.', {}, { 'Retry-After': '1' });
    }
  });
}
