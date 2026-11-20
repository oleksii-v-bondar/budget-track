import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const RECOVERY_CODE_COUNT = 10;
// No 0/O, 1/I/L: codes are typed in by hand.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const GROUPS = 3;
const GROUP_LENGTH = 4;

/** Ten single-use codes like "7KQM-W3XP-9DHR" (about 59 bits each), shown to the user once. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () =>
    Array.from({ length: GROUPS }, () =>
      Array.from({ length: GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
    ).join('-'),
  );
}

/** Upper-cases and strips separators/spaces so "7kqm w3xp 9dhr" matches "7KQM-W3XP-9DHR". */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => hash(normalizeRecoveryCode(code))));
}

/** If `input` matches one of `hashes`, returns the remaining hashes (the code is used up); otherwise null. */
export async function consumeRecoveryCode(hashes: string[], input: string): Promise<string[] | null> {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length !== GROUPS * GROUP_LENGTH) return null;
  for (const [index, candidate] of hashes.entries()) {
    if (await verify(candidate, normalized).catch(() => false)) {
      return hashes.filter((_, i) => i !== index);
    }
  }
  return null;
}
