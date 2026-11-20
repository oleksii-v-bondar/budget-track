import { consumeRecoveryCode } from './recovery-codes';
import { decryptSecret } from './secret-box';
import { verifyTotp } from './totp';
import type { AppUser } from './user';

/** Exactly one of these should be set; with neither, the check fails. */
export interface SecondFactor {
  totpCode?: string;
  recoveryCode?: string;
}

export interface SecondFactorResult {
  ok: boolean;
  /** The user's recovery code hashes without the one just used. Store them only if the whole sign-in succeeds. */
  remainingRecoveryHashes: string[];
}

/**
 * Checks an authenticator code or a recovery code. It does the same work whether or not the password was right, so
 * call it even after a wrong password: the response time then doesn't reveal the password.
 */
export async function verifySecondFactor(
  user: Pick<AppUser, 'totpSecretEnc' | 'recoveryCodeHashes'>,
  factor: SecondFactor,
  now: Date,
  encryptionKey: Buffer,
): Promise<SecondFactorResult> {
  const unchanged = { remainingRecoveryHashes: user.recoveryCodeHashes };
  if (factor.totpCode !== undefined) {
    const ok = await verifyTotp(decryptSecret(user.totpSecretEnc, encryptionKey), factor.totpCode, now);
    return { ok, ...unchanged };
  }
  if (factor.recoveryCode !== undefined) {
    const remaining = await consumeRecoveryCode(user.recoveryCodeHashes, factor.recoveryCode);
    return remaining ? { ok: true, remainingRecoveryHashes: remaining } : { ok: false, ...unchanged };
  }
  return { ok: false, ...unchanged };
}
