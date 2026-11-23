import { DomainError } from '../http/errors';
import { consumeRecoveryCode } from './recovery-codes';
import { decryptSecret } from './secret-box';
import { verifyTotp } from './totp';
import type { AppUser } from './user';

/** With an authenticator on, exactly one of these should be set; with neither, the check fails. */
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

/** Whether the owner has turned on an authenticator app (it is off by default). */
export function hasAuthenticator(user: Pick<AppUser, 'totpSecretEnc'>): boolean {
  return user.totpSecretEnc !== null;
}

/**
 * While an authenticator is on, refuses a check that sends neither code with 422 `code_required`. Call it before
 * checking the password: it depends only on the request and on whether an authenticator is on, which
 * `GET /api/auth/status` reveals anyway, so it isn't a sign-in attempt.
 */
export function assertFactorSent(user: Pick<AppUser, 'totpSecretEnc'>, factor: SecondFactor): void {
  if (!hasAuthenticator(user) || factor.totpCode !== undefined || factor.recoveryCode !== undefined) return;
  throw new DomainError('code_required', 'Enter a code from your authenticator app or a recovery code.');
}

/**
 * Checks an authenticator code or a recovery code. It does the same work whether or not the password was right, so
 * call it even after a wrong password: the response time then doesn't reveal the password. Without an authenticator
 * there is no second factor: the check passes and ignores any code sent.
 */
export async function verifySecondFactor(
  user: Pick<AppUser, 'totpSecretEnc' | 'recoveryCodeHashes' | 'totpLastStep'>,
  factor: SecondFactor,
  now: Date,
  encryptionKey: Buffer,
): Promise<SecondFactorResult> {
  const unchanged = { remainingRecoveryHashes: user.recoveryCodeHashes };
  if (user.totpSecretEnc === null) return { ok: true, ...unchanged };
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
