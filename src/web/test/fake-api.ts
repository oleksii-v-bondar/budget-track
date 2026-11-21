import { vi } from 'vitest';

export interface FakeRequest {
  method: string;
  /** Path and query, e.g. `/api/budget/2026-11`. */
  path: string;
  headers: Headers;
  /** The parsed JSON body, if any. */
  body: unknown;
}

type Reply = Response | { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = Reply | ((request: FakeRequest) => Reply | Promise<Reply>);

/** A JSON response, as the server sends it. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * Replaces `fetch` with a fake server for component tests. `routes` maps `"METHOD /path"` to a reply or a function
 * making one; unknown routes answer 404 like the server. Every request is recorded in `requests`.
 */
export function fakeApi(routes: Record<string, Handler>) {
  const requests: FakeRequest[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    const text = typeof init.body === 'string' ? init.body : '';
    const request: FakeRequest = {
      method,
      path: url.pathname + url.search,
      headers: new Headers(init.headers),
      body: text ? JSON.parse(text) : undefined,
    };
    requests.push(request);
    const handler = routes[`${method} ${url.pathname}`];
    if (handler === undefined) return json({ code: 'not_found', message: 'Not found.' }, 404);
    const reply = typeof handler === 'function' ? await handler(request) : handler;
    return reply instanceof Response ? reply : json(reply.body ?? {}, reply.status ?? 200, reply.headers);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, requests };
}
