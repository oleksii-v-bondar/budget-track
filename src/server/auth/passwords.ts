import { hash, verify } from '@node-rs/argon2';

/** argon2id with the library's OWASP-aligned defaults. */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** False for a wrong password or a malformed hash; never throws. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
