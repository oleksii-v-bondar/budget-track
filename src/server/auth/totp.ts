import { generateSecret, generateURI, verify } from 'otplib';

export const TOTP_ISSUER = 'Budget Track';
const TOTP_LABEL = 'owner';

/** A new random base32 secret (160 bits) for an authenticator app. */
export function newTotpSecret(): string {
  return generateSecret();
}

/** otpauth:// URI the setup screen renders as a QR code. */
export function totpUri(secret: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: TOTP_LABEL, secret });
}

/**
 * Spec §12: 30 s step, ±1 step of clock drift. Returns the RFC 6238 time step the code belongs to (callers store it
 * to refuse replays), or null for a wrong code and for malformed codes or secrets.
 */
export async function verifyTotp(secret: string, code: string, now: Date): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  try {
    const result = await verify({
      secret,
      token: code,
      epoch: Math.floor(now.getTime() / 1000),
      epochTolerance: 30,
    });
    // verify() also covers HOTP, whose results have no time step.
    return result.valid && 'timeStep' in result ? result.timeStep : null;
  } catch {
    return null;
  }
}
