import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLogger } from '../logger';
import type { AppEnv } from './env';
import { AppError, DomainError, errorHandler } from './errors';
import { validate } from './validate';

function appWith(routes: (app: Hono<AppEnv>) => void) {
  const logger = createLogger('silent');
  const errorSpy = vi.spyOn(logger, 'error');
  const app = new Hono<AppEnv>().use(requestId()).use(async (c, next) => {
    c.set('logger', logger);
    await next();
  });
  routes(app);
  app.onError(errorHandler);
  return { app, errorSpy };
}

describe('errorHandler', () => {
  it('maps AppError to its status and code', async () => {
    const { app } = appWith((a) => a.get('/x', () => Promise.reject(new AppError(409, 'conflict', 'Already there.'))));
    const res = await app.request('/x');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'conflict', message: 'Already there.' });
  });

  it('maps DomainError to 422', async () => {
    const { app } = appWith((a) => a.get('/x', () => Promise.reject(new DomainError('split_sum', 'Lines must add up.'))));
    const res = await app.request('/x');
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: 'split_sum', message: 'Lines must add up.' });
  });

  it('maps validation failures to 400 with field errors', async () => {
    const schema = z.object({ name: z.string().min(1), amount: z.number().int() });
    const { app } = appWith((a) => a.post('/x', validate('json', schema), (c) => c.json(c.req.valid('json'))));
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', amount: 1.5 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; fieldErrors: Record<string, string[]> };
    expect(body.code).toBe('validation');
    expect(Object.keys(body.fieldErrors).sort()).toEqual(['amount', 'name']);
  });

  it('maps malformed JSON to 400', async () => {
    const { app } = appWith((a) => a.post('/x', validate('json', z.object({})), (c) => c.json({})));
    const res = await app.request('/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('bad_request');
  });

  it('maps other HTTPExceptions to http_<status>', async () => {
    const { app } = appWith((a) => a.get('/x', () => Promise.reject(new HTTPException(413, { message: 'Too big' }))));
    const res = await app.request('/x');
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: 'http_413', message: 'Too big' });
  });

  it('hides unexpected errors behind a generic 500 and logs them', async () => {
    const { app, errorSpy } = appWith((a) => a.get('/x', () => Promise.reject(new Error('db password is hunter2'))));
    const res = await app.request('/x');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string; requestId: string };
    expect(body).toEqual({ code: 'internal', message: 'Something went wrong.', requestId: res.headers.get('x-request-id') });
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
