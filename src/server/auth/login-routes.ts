import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { type AuthStatus, loginRequestSchema } from '../../shared/auth';
import type { AppDeps } from '../http/app';
import type { AppEnv } from '../http/env';
import { AppError } from '../http/errors';
import { validate } from '../http/validate';
import { clearSessionCookie, createSession, deleteSession, refreshSession, requireSession, setSessionCookie } from './sessions';

/** Constant-time comparison (hashing first makes the lengths equal). */
function matches(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** Sign-in with the username and password from the environment (APP_USERNAME, APP_PASSWORD). */
export function loginRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .get('/status', async (c) => {
      // Also keeps the cookie's lifetime sliding while the app only polls its status, and clears a stale cookie.
      const authenticated = (await refreshSession(c, deps)) !== null;
      return c.json<AuthStatus>({ authenticated });
    })
    .post('/login', validate('json', loginRequestSchema), async (c) => {
      const { username, password } = c.req.valid('json');
      // Both are always compared, so the response time doesn't reveal whether the username was right.
      const usernameOk = matches(username, deps.config.appUsername);
      const passwordOk = matches(password, deps.config.appPassword);
      if (!usernameOk || !passwordOk) throw new AppError(401, 'invalid_credentials', 'Wrong username or password.');

      const { token } = await createSession(deps.db, deps.clock.now(), c.req.header('user-agent'));
      setSessionCookie(c, token, deps.config.cookieSecure);
      return c.json({ ok: true as const });
    })
    .post('/logout', requireSession(deps), async (c) => {
      await deleteSession(deps.db, c.var.session.id);
      clearSessionCookie(c, deps.config.cookieSecure);
      return c.json({ ok: true as const });
    });
}
