import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { z } from 'zod';
import { ValidationError } from './errors';

/** zod request validation that reports failures in the API's error format (HTTP 400, code "validation"). */
export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) throw new ValidationError(result.error);
  });
}
