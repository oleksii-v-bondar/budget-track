import { describe, expect, it } from 'vitest';
import {
  changePasswordRequestSchema,
  confirmTotpRequestSchema,
  disableTotpRequestSchema,
  loginRequestSchema,
  reauthRequestSchema,
  setupRequestSchema,
} from './auth';

describe('auth request schemas', () => {
  it('require the setup token and a 12+ character password at setup, and nothing about an authenticator', () => {
    const ok = { setupToken: 't', password: 'twelve chars' };
    expect(setupRequestSchema.safeParse(ok).success).toBe(true);
    expect(setupRequestSchema.safeParse({ ...ok, password: 'eleven char' }).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...ok, setupToken: '' }).success).toBe(false);
    expect(setupRequestSchema.parse({ ...ok, totpSecret: 'A'.repeat(32), totpCode: '123456' })).toEqual(ok);
  });

  it('cap the setup token at 256 characters', () => {
    const ok = { setupToken: 't', password: 'twelve chars' };
    expect(setupRequestSchema.safeParse({ ...ok, setupToken: 'x'.repeat(256) }).success).toBe(true);
    expect(setupRequestSchema.safeParse({ ...ok, setupToken: 'x'.repeat(257) }).success).toBe(false);
  });

  it('explain too long or empty inputs in words', () => {
    const messages = (result: { error?: { issues: { message: string }[] } }) => result.error?.issues.map((i) => i.message);
    expect(messages(setupRequestSchema.safeParse({ setupToken: 'x'.repeat(257), password: 'twelve chars' }))).toEqual([
      'That setup token is too long.',
    ]);
    expect(messages(loginRequestSchema.safeParse({ password: 'x'.repeat(257), recoveryCode: 'y'.repeat(65) }))).toEqual([
      'Use at most 256 characters.',
      'That recovery code is too long.',
    ]);
    expect(messages(loginRequestSchema.safeParse({ password: 'p', recoveryCode: '' }))).toEqual(['Enter a recovery code.']);
  });

  it('allow at most one second factor at login (none without an authenticator)', () => {
    expect(loginRequestSchema.safeParse({ password: 'p' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ password: 'p', totpCode: '123456' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ password: 'p', recoveryCode: 'AAAA-BBBB-CCCC' }).success).toBe(true);
    expect(
      loginRequestSchema.safeParse({ password: 'p', totpCode: '123456', recoveryCode: 'AAAA-BBBB-CCCC' }).success,
    ).toBe(false);
  });

  it('make the authenticator code optional when re-authenticating', () => {
    expect(changePasswordRequestSchema.safeParse({ currentPassword: 'p', newPassword: 'twelve chars' }).success).toBe(true);
    expect(reauthRequestSchema.safeParse({ currentPassword: 'p' }).success).toBe(true);
    expect(reauthRequestSchema.safeParse({ currentPassword: 'p', totpCode: '12345' }).success).toBe(false);
    const turnOn = { currentPassword: 'p', totpSecret: 'A'.repeat(32), totpCode: '123456' };
    expect(confirmTotpRequestSchema.safeParse(turnOn).success).toBe(true);
    expect(
      confirmTotpRequestSchema.safeParse({ ...turnOn, currentTotpCode: '123456', recoveryCode: 'AAAA-BBBB-CCCC' }).success,
    ).toBe(false);
  });

  it('require exactly one current factor to turn the authenticator off', () => {
    expect(disableTotpRequestSchema.safeParse({ currentPassword: 'p', totpCode: '123456' }).success).toBe(true);
    expect(disableTotpRequestSchema.safeParse({ currentPassword: 'p', recoveryCode: 'AAAA-BBBB-CCCC' }).success).toBe(true);
    expect(disableTotpRequestSchema.safeParse({ currentPassword: 'p' }).success).toBe(false);
    expect(
      disableTotpRequestSchema.safeParse({ currentPassword: 'p', totpCode: '123456', recoveryCode: 'AAAA-BBBB-CCCC' })
        .success,
    ).toBe(false);
  });
});
