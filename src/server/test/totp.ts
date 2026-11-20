import { generate } from 'otplib';

/** The 6-digit code an authenticator app would show for `secret` at `at`. */
export function totpCode(secret: string, at: Date): Promise<string> {
  return generate({ secret, epoch: Math.floor(at.getTime() / 1000) });
}
