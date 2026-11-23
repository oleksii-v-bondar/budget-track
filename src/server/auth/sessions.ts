import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lte } from 'drizzle-orm';
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

/**
 * Lax, not Strict: the bank's redirect back to /api/bank/callback is a top-level GET from another site, and it needs
 * the session. Lax still keeps the cookie off cross-site subrequests and non-GET navigations, every non-GET request
 * must carry the CSRF header (csrfGuard), and the one GET that writes (the callback) also needs the state cookie that
 * /api/bank/connect set.
 */
export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'Lax', path: '/' });
}

interface SessionDeps {
  db: Executor;
  clock: Clock;
  config: { cookieSecure: boolean };
}

/**
 * The live session behind the request's cookie, or null. Slides the session's expiry and refreshes the cookie so its
 * lifetime slides too; a cookie for an unknown or expired session is cleared.
 */
export async function refreshSession(c: Context, deps: SessionDeps): Promise<SessionInfo | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const found = await findSession(deps.db, token, deps.clock.now());
  if (found) setSessionCookie(c, token, deps.config.cookieSecure);
  else clearSessionCookie(c, deps.config.cookieSecure);
  return found;
}

/** 401 unless the request carries a live session (see refreshSession). */
export function requireSession(deps: SessionDeps): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    const found = await refreshSession(c, deps);
    if (!found) throw new AppError(401, 'unauthorized', 'Please sign in.');
    c.set('session', found);
    await next();
  };
}
