import { describe, expect, it } from 'vitest';
import { loginRequestSchema, setupRequestSchema } from './auth';

describe('auth request schemas', () => {
  it('require a 12+ character password, a base32 secret and a 6-digit code at setup', () => {
    const ok = { setupToken: 't', password: 'twelve chars', totpSecret: 'A'.repeat(32), totpCode: '123456' };
    expect(setupRequestSchema.safeParse(ok).success).toBe(true);
    expect(setupRequestSchema.safeParse({ ...ok, password: 'eleven char' }).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...ok, totpSecret: 'a'.repeat(32) }).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...ok, totpCode: '12345' }).success).toBe(false);
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
