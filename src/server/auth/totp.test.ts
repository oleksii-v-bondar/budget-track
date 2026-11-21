import { describe, expect, it } from 'vitest';
import { totpCode } from '../test/totp';
import { newTotpSecret, totpUri, verifyTotp } from './totp';

// 1_800_000_000 is a multiple of 30, so this instant starts a TOTP step (step 60 000 000).
const stepStart = new Date(1_800_000_000 * 1000);
const STEP = 60_000_000;
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

  it("accepts the current code and one step of drift, but not two, and returns the code's time step", async () => {
    const secret = newTotpSecret();
    const code = await totpCode(secret, stepStart);
    expect(await verifyTotp(secret, code, stepStart)).toBe(STEP);
    expect(await verifyTotp(secret, code, seconds(59))).toBe(STEP);
    expect(await verifyTotp(secret, code, seconds(-30))).toBe(STEP);
    expect(await verifyTotp(secret, code, seconds(60))).toBeNull();
    expect(await verifyTotp(secret, code, seconds(-31))).toBeNull();
    expect(await verifyTotp(secret, await totpCode(secret, seconds(30)), stepStart)).toBe(STEP + 1);
  });

  it('rejects malformed codes and secrets without throwing', async () => {
    const secret = newTotpSecret();
    expect(await verifyTotp(secret, '12345', stepStart)).toBeNull();
    expect(await verifyTotp(secret, 'abcdef', stepStart)).toBeNull();
    expect(await verifyTotp('not base32!', '123456', stepStart)).toBeNull();
  });
});
