import { describe, expect, it } from 'vitest';
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCodes,
  normalizeRecoveryCode,
} from './recovery-codes';

describe('recovery codes', () => {
  it('generates ten distinct, readable codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  });

  it('normalizes case, spaces and dashes', () => {
    expect(normalizeRecoveryCode(' 7kqm w3xp-9dhr ')).toBe('7KQMW3XP9DHR');
  });

  it('accepts each code once and leaves the others', async () => {
    const codes = generateRecoveryCodes(3);
    const hashes = await hashRecoveryCodes(codes);
    const remaining = await consumeRecoveryCode(hashes, codes[1]!.toLowerCase());
    expect(remaining).toHaveLength(2);
    expect(await consumeRecoveryCode(remaining!, codes[1]!)).toBeNull();
    expect(await consumeRecoveryCode(remaining!, codes[0]!)).toHaveLength(1);
  });

  it('rejects unknown and malformed codes', async () => {
    const hashes = await hashRecoveryCodes(generateRecoveryCodes(2));
    expect(await consumeRecoveryCode(hashes, 'AAAA-AAAA-AAAA')).toBeNull();
    expect(await consumeRecoveryCode(hashes, 'short')).toBeNull();
  });
});
