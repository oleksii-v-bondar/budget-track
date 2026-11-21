import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { ApiErrorBody } from '../../shared/http';
import type { AppEnv } from './env';

/**
 * An error whose message is safe to show to the user; mapped to `status` with body `{ code, message, ... }` and the
 * given response headers (e.g. `Retry-After`).
 */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly extra: Omit<ApiErrorBody, 'code' | 'message'> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * A violated business rule (spec §13): HTTP 422. `field` names the request field it concerns, as a dotted path
 * (e.g. `lines.1.categoryId`); the body then also carries `fieldErrors: { [field]: [message] }`.
 */
export class DomainError extends AppError {
  constructor(code: string, message: string, field?: string) {
    super(422, code, message, field === undefined ? {} : { fieldErrors: { [field]: [message] } });
    this.name = 'DomainError';
  }
}

/**
 * Request validation failure (spec §13): HTTP 400 `{ code: "validation", fieldErrors, formErrors }`. Field errors are
 * keyed by the dotted issue path, so nested fields keep theirs (`lines.1.amount`); `z.flattenError` would report
 * only the top-level key.
 */
export class ValidationError extends AppError {
  constructor(error: z.core.$ZodError) {
    const fieldErrors: Record<string, string[]> = {};
    const formErrors: string[] = [];
    for (const issue of error.issues) {
      if (issue.path.length === 0) formErrors.push(issue.message);
      else (fieldErrors[issue.path.map(String).join('.')] ??= []).push(issue.message);
    }
    super(400, 'validation', 'Some fields are invalid.', { fieldErrors, formErrors });
    this.name = 'ValidationError';
  }
}

export function errorHandler(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof AppError) {
    return c.json<ApiErrorBody>({ code: err.code, message: err.message, ...err.extra }, err.status, err.headers);
  }
  if (err instanceof HTTPException) {
    const code = err.status === 400 ? 'bad_request' : `http_${err.status}`;
    return c.json<ApiErrorBody>({ code, message: err.message }, err.status);
  }
  c.var.logger.error({ err }, 'unhandled error');
  return c.json<ApiErrorBody>(
    { code: 'internal', message: 'Something went wrong.', requestId: c.var.requestId },
    500,
  );
}
