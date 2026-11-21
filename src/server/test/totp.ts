import { generate } from 'otplib';
import type { FakeClock } from './fake-clock';

export const TOTP_STEP_MS = 30_000;

/** The 6-digit code an authenticator app would show for `secret` at `at`. */
export function totpCode(secret: string, at: Date): Promise<string> {
  return generate({ secret, epoch: Math.floor(at.getTime() / 1000) });
}

/**
 * Moves `clock` on by one TOTP step and returns the code for the new time. Each accepted code must come from a newer
 * step than the last one (replay protection), so tests that sign in more than once use this.
 */
export function freshTotpCode(secret: string, clock: FakeClock): Promise<string> {
  clock.advance(TOTP_STEP_MS);
  return totpCode(secret, clock.now());
}
