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
  /** The time step of the authenticator code that matched. Store it only if the whole sign-in succeeds. */
  totpStep?: number;
}

/**
 * Checks an authenticator code or a recovery code. It does the same work whether or not the password was right, so
 * call it even after a wrong password: the response time then doesn't reveal the password.
 */
export async function verifySecondFactor(
  user: Pick<AppUser, 'totpSecretEnc' | 'recoveryCodeHashes' | 'totpLastStep'>,
  factor: SecondFactor,
  now: Date,
  encryptionKey: Buffer,
): Promise<SecondFactorResult> {
  const unchanged = { remainingRecoveryHashes: user.recoveryCodeHashes };
  if (factor.totpCode !== undefined) {
    const step = await verifyTotp(decryptSecret(user.totpSecretEnc, encryptionKey), factor.totpCode, now);
    // Each code works once (RFC 6238 §5.2): a code from the step of the last accepted one, or earlier, is a replay.
    if (step === null || step <= (user.totpLastStep ?? -1)) return { ok: false, ...unchanged };
    return { ok: true, totpStep: step, ...unchanged };
  }
  if (factor.recoveryCode !== undefined) {
    const remaining = await consumeRecoveryCode(user.recoveryCodeHashes, factor.recoveryCode);
    return remaining ? { ok: true, remainingRecoveryHashes: remaining } : { ok: false, ...unchanged };
  }
  return { ok: false, ...unchanged };
}

/** The columns to store once a check with `result` has passed: the unused recovery codes and the newest code's step. */
export function spentFactor(
  user: Pick<AppUser, 'totpLastStep'>,
  result: SecondFactorResult,
): Pick<AppUser, 'recoveryCodeHashes' | 'totpLastStep'> {
  return { recoveryCodeHashes: result.remainingRecoveryHashes, totpLastStep: result.totpStep ?? user.totpLastStep };
}
