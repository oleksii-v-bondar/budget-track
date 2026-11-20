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

/** Spec §12: 30 s step, ±1 step of clock drift. False for malformed codes or secrets. */
export async function verifyTotp(secret: string, code: string, now: Date): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    const result = await verify({
      secret,
      token: code,
      epoch: Math.floor(now.getTime() / 1000),
      epochTolerance: 30,
    });
    return result.valid;
  } catch {
    return false;
  }
}
