import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newPasswordSchema } from '../../shared/auth';
import { ApiError } from './api';
import { formErrorsOf, NO_ERRORS, zodFormErrors } from './form-errors';

const validation = (fieldErrors: Record<string, string[]>, formErrors: string[] = []) =>
  new ApiError(400, { code: 'validation', message: 'Some fields are invalid.', fieldErrors, formErrors });

describe('formErrorsOf', () => {
  it('shows nothing without an error', () => {
    expect(formErrorsOf(null, ['password'])).toEqual(NO_ERRORS);
  });

  it('puts field messages under the fields the form shows, by dotted path', () => {
    const error = validation({ password: ['Use at least 12 characters.', 'second'], 'lines.1.amount': ['Enter an amount.'] });
    expect(formErrorsOf(error, ['password', 'lines.1.amount'])).toEqual({
      fields: { password: 'Use at least 12 characters.', 'lines.1.amount': 'Enter an amount.' },
      form: null,
    });
  });

  it('moves messages for fields the form does not show, and form-level ones, above the button', () => {
    const error = validation({ totpSecret: ['Invalid authenticator secret.'] }, ['Enter either a code or a recovery code.']);
    expect(formErrorsOf(error, ['password'])).toEqual({
      fields: {},
      form: 'Enter either a code or a recovery code. Invalid authenticator secret.',
    });
  });

  it('shows a domain error about one field under it, and other errors above the button', () => {
    const onField = new ApiError(422, {
      code: 'invalid_totp_code',
      message: "That code didn't match.",
      fieldErrors: { totpCode: ["That code didn't match."] },
    });
    expect(formErrorsOf(onField, ['totpCode'])).toEqual({ fields: { totpCode: "That code didn't match." }, form: null });
    const conflict = new ApiError(409, { code: 'undo_conflict', message: "Can't undo: data changed since." });
    expect(formErrorsOf(conflict, [])).toEqual({ fields: {}, form: "Can't undo: data changed since." });
    expect(formErrorsOf(new TypeError('x'), [])).toEqual({ fields: {}, form: 'Something went wrong. Try again.' });
  });

  it('says when to try again after a rate limit', () => {
    const limited = (retryAfter: number) =>
      new ApiError(429, { code: 'rate_limited', message: 'Too many sign-in attempts.' }, retryAfter);
    expect(formErrorsOf(limited(30), []).form).toBe('Too many sign-in attempts. You can try again in 30 seconds.');
    expect(formErrorsOf(limited(870), []).form).toBe('Too many sign-in attempts. You can try again in 15 minutes.');
  });
});

describe('zodFormErrors', () => {
  it('reports a shared schema the way the server would', () => {
    const schema = z.object({ password: newPasswordSchema, lines: z.array(z.object({ amount: z.int() })) });
    const result = schema.safeParse({ password: 'short', lines: [{ amount: 1 }, { amount: 'x' }] });
    expect(zodFormErrors(result.error!, ['password', 'lines.1.amount'])).toEqual({
      fields: { password: 'Use at least 12 characters.', 'lines.1.amount': expect.any(String) },
      form: null,
    });
  });
});
