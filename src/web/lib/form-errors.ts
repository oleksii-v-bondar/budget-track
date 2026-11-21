import type { z } from 'zod';
import { ApiError, UNEXPECTED_ERROR_MESSAGE } from './api';

/** What a form shows for a failed request: messages under its fields and one message above the submit button. */
export interface FormErrors {
  /** The first message per field, keyed by the dotted path the server uses (`password`, `lines.1.amount`). */
  fields: Record<string, string>;
  form: string | null;
}

export const NO_ERRORS: FormErrors = { fields: {}, form: null };

function waitText(seconds: number): string {
  return seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}

/**
 * Splits a failed request into field and form messages (spec §13). Field messages (400 validation, a 422 about one
 * field) go under the fields in `shown`; messages for any other field, `formErrors` and every other error go to the
 * form. A 429/503 says when to try again (`Retry-After`).
 */
export function formErrorsOf(error: unknown, shown: readonly string[]): FormErrors {
  if (error === null || error === undefined) return NO_ERRORS;
  if (!(error instanceof ApiError)) return { fields: {}, form: UNEXPECTED_ERROR_MESSAGE };
  const fields: Record<string, string> = {};
  const elsewhere: string[] = [...error.formErrors];
  for (const [path, messages] of Object.entries(error.fieldErrors)) {
    if (!messages[0]) continue;
    if (shown.includes(path)) fields[path] ??= messages[0];
    else elsewhere.push(messages[0]);
  }
  let form = elsewhere.length > 0 ? elsewhere.join(' ') : null;
  if (form === null && Object.keys(fields).length === 0) form = error.message;
  if (form !== null && error.retryAfter !== null) form = `${form} You can try again in ${waitText(error.retryAfter)}.`;
  return { fields, form };
}

/** The same split for a client-side check with a shared zod schema (issues keyed by dotted path, like the server). */
export function zodFormErrors(error: z.core.$ZodError, shown: readonly string[]): FormErrors {
  const fieldErrors: Record<string, string[]> = {};
  const formErrors: string[] = [];
  for (const issue of error.issues) {
    if (issue.path.length === 0) formErrors.push(issue.message);
    else (fieldErrors[issue.path.map(String).join('.')] ??= []).push(issue.message);
  }
  return formErrorsOf(
    new ApiError(400, { code: 'validation', message: 'Some fields are invalid.', fieldErrors, formErrors }),
    shown,
  );
}
