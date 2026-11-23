import { describe, expect, it } from 'vitest';
import { totpCode } from '../test/totp';
import { assertFactorSent, spentFactor, verifySecondFactor } from './second-factor';
import { encryptSecret } from './secret-box';
import { verifyTotp } from './totp';

const key = Buffer.alloc(32, 5);
const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const now = new Date('2026-11-20T10:00:00Z');
const user = { totpSecretEnc: encryptSecret(secret, key), recoveryCodeHashes: [], totpLastStep: null };

describe('verifySecondFactor', () => {
  it('fails when no second factor is given', async () => {
    const code = await totpCode(secret, now);
    expect(await verifySecondFactor(user, { totpCode: code }, now, key)).toMatchObject({ ok: true });
    expect(await verifySecondFactor(user, {}, now, key)).toEqual({ ok: false, remainingRecoveryHashes: [] });
  });

  it('accepts each authenticator code once: only codes from a step after the last one used', async () => {
    const code = await totpCode(secret, now);
    const step = (await verifyTotp(secret, code, now))!;
    const fresh = await verifySecondFactor({ ...user, totpLastStep: step - 1 }, { totpCode: code }, now, key);
    expect(fresh).toEqual({ ok: true, totpStep: step, remainingRecoveryHashes: [] });
    for (const totpLastStep of [step, step + 1]) {
      expect(await verifySecondFactor({ ...user, totpLastStep }, { totpCode: code }, now, key)).toEqual({
        ok: false,
        remainingRecoveryHashes: [],
      });
    }
    expect(spentFactor({ totpLastStep: step - 1 }, fresh)).toEqual({ recoveryCodeHashes: [], totpLastStep: step });
    expect(spentFactor({ totpLastStep: 7 }, { ok: true, remainingRecoveryHashes: ['x'] })).toEqual({
      recoveryCodeHashes: ['x'],
      totpLastStep: 7,
    });
  });
});

describe('without an authenticator', () => {
  const owner = { totpSecretEnc: null, recoveryCodeHashes: [], totpLastStep: null };

  it('needs no second factor and ignores any code sent', async () => {
    for (const factor of [{}, { totpCode: '000000' }, { recoveryCode: 'AAAA-AAAA-AAAA' }]) {
      expect(await verifySecondFactor(owner, factor, now, key)).toEqual({ ok: true, remainingRecoveryHashes: [] });
      expect(() => assertFactorSent(owner, factor)).not.toThrow();
    }
  });
});

describe('assertFactorSent', () => {
  it('refuses a check without a code while an authenticator is on', () => {
    expect(() => assertFactorSent(user, { totpCode: '123456' })).not.toThrow();
    expect(() => assertFactorSent(user, { recoveryCode: 'AAAA-AAAA-AAAA' })).not.toThrow();
    expect(() => assertFactorSent(user, {})).toThrow(
      expect.objectContaining({ status: 422, code: 'code_required' }) as Error,
    );
  });
});
