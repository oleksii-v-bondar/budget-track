import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { ApiErrorBody } from '../../shared/http';
import type { AppEnv } from './env';

/** An error whose message is safe to show to the user; mapped to `status` with body `{ code, message, ... }`. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly extra: Omit<ApiErrorBody, 'code' | 'message'> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** A violated business rule (spec §13): HTTP 422. */
export class DomainError extends AppError {
  constructor(code: string, message: string) {
    super(422, code, message);
    this.name = 'DomainError';
  }
}

/** Request validation failure (spec §13): HTTP 400 `{ code: "validation", fieldErrors, formErrors }`. */
export class ValidationError extends AppError {
  constructor(error: z.core.$ZodError) {
    const flat = z.flattenError(error);
    super(400, 'validation', 'Some fields are invalid.', {
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
      formErrors: flat.formErrors,
    });
    this.name = 'ValidationError';
  }
}

export function errorHandler(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof AppError) {
    return c.json<ApiErrorBody>({ code: err.code, message: err.message, ...err.extra }, err.status);
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
