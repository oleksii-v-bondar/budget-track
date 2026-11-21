import { describe, expect, it } from 'vitest';
import { loginRequestSchema, setupRequestSchema, setupTotpRequestSchema } from './auth';

describe('auth request schemas', () => {
  it('require a 12+ character password, a base32 secret and a 6-digit code at setup', () => {
    const ok = { setupToken: 't', password: 'twelve chars', totpSecret: 'A'.repeat(32), totpCode: '123456' };
    expect(setupRequestSchema.safeParse(ok).success).toBe(true);
    expect(setupRequestSchema.safeParse({ ...ok, password: 'eleven char' }).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...ok, totpSecret: 'a'.repeat(32) }).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...ok, totpCode: '12345' }).success).toBe(false);
  });

  it('cap the setup token at 256 characters', () => {
    const ok = { setupToken: 't', password: 'twelve chars', totpSecret: 'A'.repeat(32), totpCode: '123456' };
    expect(setupTotpRequestSchema.safeParse({ setupToken: 'x'.repeat(256) }).success).toBe(true);
    expect(setupTotpRequestSchema.safeParse({ setupToken: 'x'.repeat(257) }).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...ok, setupToken: 'x'.repeat(256) }).success).toBe(true);
    expect(setupRequestSchema.safeParse({ ...ok, setupToken: 'x'.repeat(257) }).success).toBe(false);
  });

  it('explain too long or empty inputs in words', () => {
    const messages = (result: { error?: { issues: { message: string }[] } }) => result.error?.issues.map((i) => i.message);
    expect(messages(setupTotpRequestSchema.safeParse({ setupToken: 'x'.repeat(257) }))).toEqual([
      'That setup token is too long.',
    ]);
    expect(messages(loginRequestSchema.safeParse({ password: 'x'.repeat(257), recoveryCode: 'y'.repeat(65) }))).toEqual([
      'Use at most 256 characters.',
      'That recovery code is too long.',
    ]);
    expect(messages(loginRequestSchema.safeParse({ password: 'p', recoveryCode: '' }))).toEqual(['Enter a recovery code.']);
  });

  it('require exactly one second factor at login', () => {
    expect(loginRequestSchema.safeParse({ password: 'p', totpCode: '123456' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ password: 'p', recoveryCode: 'AAAA-BBBB-CCCC' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ password: 'p' }).success).toBe(false);
    expect(
      loginRequestSchema.safeParse({ password: 'p', totpCode: '123456', recoveryCode: 'AAAA-BBBB-CCCC' }).success,
    ).toBe(false);
  });
});
