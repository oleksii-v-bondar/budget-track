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

/** The handler for a request: an exact `"METHOD /path"` first, then a pattern whose `:name` segments match any one. */
function findHandler(routes: Record<string, Handler>, method: string, path: string): Handler | undefined {
  const exact = routes[`${method} ${path}`];
  if (exact !== undefined) return exact;
  const segments = path.split('/');
  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, pattern = ''] = key.split(' ');
    const parts = pattern.split('/');
    if (routeMethod !== method || parts.length !== segments.length) continue;
    if (parts.every((part, i) => part === segments[i] || (part.startsWith(':') && segments[i] !== ''))) return handler;
  }
  return undefined;
}

/**
 * Replaces `fetch` with a fake server for component tests. `routes` maps `"METHOD /path"` to a reply or a function
 * making one; a `:name` segment matches any one segment (`"GET /api/budget/:month"`; read it from `request.path`).
 * Unknown routes answer 404 like the server. Every request is recorded in `requests`.
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
    const handler = findHandler(routes, method, url.pathname);
    if (handler === undefined) return json({ code: 'not_found', message: 'Not found.' }, 404);
    const reply = typeof handler === 'function' ? await handler(request) : handler;
    return reply instanceof Response ? reply : json(reply.body ?? {}, reply.status ?? 200, reply.headers);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, requests };
}

/**
 * The fake server's undo stack for command tests: `push` the label a command's undo entry gets, and spread `route`
 * into fakeApi so `GET /api/undo` reports it (the command toast reads it).
 */
export function undoStack() {
  let undo: { label: string } | null = null;
  return {
    push: (label: string) => {
      undo = { label };
    },
    route: { 'GET /api/undo': () => ({ body: { undo, redo: null } }) },
  };
}

/** The requests that change data, without their headers. */
export function writes(requests: FakeRequest[]) {
  return requests.filter((r) => r.method !== 'GET').map(({ method, path, body }) => ({ method, path, body }));
}
