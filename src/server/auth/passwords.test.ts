import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwords';

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const hashed = await hashPassword('correct horse battery');
    expect(hashed).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hashed, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hashed, 'wrong horse battery')).toBe(false);
  });

  it('treats a malformed hash as a failed check', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});
