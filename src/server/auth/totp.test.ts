import { describe, expect, it } from 'vitest';
import { totpCode } from '../test/totp';
import { newTotpSecret, totpUri, verifyTotp } from './totp';

// 1_800_000_000 is a multiple of 30, so this instant starts a TOTP step.
const stepStart = new Date(1_800_000_000 * 1000);
const seconds = (n: number) => new Date(stepStart.getTime() + n * 1000);

describe('totp', () => {
  it('creates base32 secrets and an otpauth URI for authenticator apps', () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const uri = totpUri(secret);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=Budget%20Track');
  });

  it('accepts the current code and one step of drift, but not two', async () => {
    const secret = newTotpSecret();
    const code = await totpCode(secret, stepStart);
    expect(await verifyTotp(secret, code, stepStart)).toBe(true);
    expect(await verifyTotp(secret, code, seconds(59))).toBe(true);
    expect(await verifyTotp(secret, code, seconds(-30))).toBe(true);
    expect(await verifyTotp(secret, code, seconds(60))).toBe(false);
    expect(await verifyTotp(secret, code, seconds(-31))).toBe(false);
  });

  it('rejects malformed codes and secrets without throwing', async () => {
    const secret = newTotpSecret();
    expect(await verifyTotp(secret, '12345', stepStart)).toBe(false);
    expect(await verifyTotp(secret, 'abcdef', stepStart)).toBe(false);
    expect(await verifyTotp('not base32!', '123456', stepStart)).toBe(false);
  });
});
