import { describe, expect, it } from 'vitest';
import { totpCode } from '../test/totp';
import { verifySecondFactor } from './second-factor';
import { encryptSecret } from './secret-box';

const key = Buffer.alloc(32, 5);
const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const now = new Date('2026-11-20T10:00:00Z');
const user = { totpSecretEnc: encryptSecret(secret, key), recoveryCodeHashes: [] };

describe('verifySecondFactor', () => {
  it('fails when no second factor is given', async () => {
    const code = await totpCode(secret, now);
    expect(await verifySecondFactor(user, { totpCode: code }, now, key)).toMatchObject({ ok: true });
    expect(await verifySecondFactor(user, {}, now, key)).toEqual({ ok: false, remainingRecoveryHashes: [] });
  });
});
