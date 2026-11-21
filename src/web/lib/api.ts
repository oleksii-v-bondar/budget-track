import { type ClientResponse, hc } from 'hono/client';
import type { SuccessStatusCode } from 'hono/utils/http-status';
import type { App } from '../../server/http/app';
import { type ApiErrorBody, CSRF_HEADER, CSRF_HEADER_VALUE } from '../../shared/http';

/**
 * The typed Hono RPC client for every /api route (`api.api.budget[':month'].$get({ param: { month } })`). Its types
 * come from the server's `App` type only; no server code is bundled. Every request carries the CSRF header the server
 * requires on mutations (spec §12).
 */
export const api = hc<App>('/', { headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE } });

/** A failed API call (spec §13): any non-2xx response, or no response at all (status 0, code "network"). */
export class ApiError extends Error {
  readonly code: string;
  /** Messages per request field, keyed by dotted path (`lines.1.amount`): 400 validation and some 422s. */
  readonly fieldErrors: Record<string, string[]>;
  /** Validation messages not tied to one field. */
  readonly formErrors: string[];
  readonly requestId: string | undefined;

  constructor(
    readonly status: number,
    body: ApiErrorBody,
    /** Seconds the server asked to wait before trying again (`Retry-After` on 429 and 503). */
    readonly retryAfter: number | null = null,
  ) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.fieldErrors = body.fieldErrors ?? {};
    this.formErrors = body.formErrors ?? [];
    this.requestId = body.requestId;
  }
}

export const NETWORK_ERROR_MESSAGE = "Can't reach the server. Check your connection and try again.";
export const UNEXPECTED_ERROR_MESSAGE = 'Something went wrong. Try again.';

/** True for the 401 every private route answers without a live session (not a wrong password at sign-in). */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code === 'unauthorized';
}

/** Worth retrying unchanged: no response, or a server-side failure. */
export function isTransient(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

function isErrorBody(body: unknown): body is ApiErrorBody {
  const b = body as Partial<ApiErrorBody> | null;
  return typeof b?.code === 'string' && typeof b.message === 'string';
}

async function errorOf(res: Response): Promise<ApiError> {
  const seconds = Number(res.headers.get('retry-after'));
  const retryAfter = Number.isInteger(seconds) && seconds > 0 ? seconds : null;
  const body: unknown = await res.json().catch(() => null);
  // Something in between (a proxy, a gateway timeout) may answer with a page of its own.
  const known = isErrorBody(body) ? body : { code: `http_${res.status}`, message: UNEXPECTED_ERROR_MESSAGE };
  return new ApiError(res.status, known, retryAfter);
}

/** The JSON body type of an RPC response's 2xx statuses. */
export type OkBody<R> =
  R extends ClientResponse<infer T, infer S, infer F> ? (S extends SuccessStatusCode ? (F extends 'json' ? T : never) : never) : never;

/** Awaits an RPC call and returns its JSON body; throws ApiError for anything but a 2xx response. */
export async function unwrap<R extends ClientResponse<unknown, number, string>>(call: Promise<R>): Promise<OkBody<R>> {
  let res: R;
  try {
    res = await call;
  } catch {
    throw new ApiError(0, { code: 'network', message: NETWORK_ERROR_MESSAGE });
  }
  if (!res.ok) throw await errorOf(res as unknown as Response);
  return (await res.json()) as OkBody<R>;
}
