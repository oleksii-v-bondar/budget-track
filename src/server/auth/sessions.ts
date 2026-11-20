import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lte, ne } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Clock } from '../clock';
import type { Executor } from '../db/client';
import { session } from '../db/schema';
import type { AppEnv } from '../http/env';
import { AppError } from '../http/errors';

export const SESSION_COOKIE = 'bt_session';
/** Spec §12: 30-day sliding expiry. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionInfo {
  id: string;
  expiresAt: Date;
}

/** Context variables available behind requireSession. */
export interface AuthedEnv {
  Variables: AppEnv['Variables'] & { session: SessionInfo };
}

/** Only the SHA-256 of the cookie token is stored, so a database leak doesn't expose live sessions. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Executor,
  now: Date,
  userAgent: string | undefined,
): Promise<{ token: string; session: SessionInfo }> {
  await db.delete(session).where(lte(session.expiresAt, now));
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const [row] = await db
    .insert(session)
    .values({ tokenHash: hashToken(token), expiresAt, lastSeenAt: now, userAgent: userAgent?.slice(0, 512) })
    .returning({ id: session.id, expiresAt: session.expiresAt });
  return { token, session: row! };
}

/** The live session for `token`, with its expiry pushed out to now + 30 days; null if unknown or expired. */
export async function findSession(db: Executor, token: string, now: Date): Promise<SessionInfo | null> {
  const [row] = await db
    .update(session)
    .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
    .where(and(eq(session.tokenHash, hashToken(token)), gt(session.expiresAt, now)))
    .returning({ id: session.id, expiresAt: session.expiresAt });
  return row ?? null;
}

export async function deleteSession(db: Executor, id: string): Promise<void> {
  await db.delete(session).where(eq(session.id, id));
}

/** Logs out everywhere, optionally keeping one session (the one changing the password). */
export async function deleteAllSessions(db: Executor, options: { exceptId?: string } = {}): Promise<void> {
  await db.delete(session).where(options.exceptId ? ne(session.id, options.exceptId) : undefined);
}

export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'Strict', path: '/' });
}

/** The session behind the request's cookie, if any (sliding its expiry). */
export async function currentSession(c: Context, deps: { db: Executor; clock: Clock }): Promise<SessionInfo | null> {
  const token = getCookie(c, SESSION_COOKIE);
  return token ? findSession(deps.db, token, deps.clock.now()) : null;
}

/** 401 unless the request carries a live session; refreshes the cookie so its lifetime slides too. */
export function requireSession(deps: {
  db: Executor;
  clock: Clock;
  config: { cookieSecure: boolean };
}): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const found = token ? await findSession(deps.db, token, deps.clock.now()) : null;
    if (!token || !found) throw new AppError(401, 'unauthorized', 'Please sign in.');
    setSessionCookie(c, token, deps.config.cookieSecure);
    c.set('session', found);
    await next();
  };
}
