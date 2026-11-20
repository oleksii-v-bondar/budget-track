import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './secret-box';

const key = Buffer.alloc(32, 3);

describe('secret box', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', key);
    const b = encryptSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', key);
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  });

  it('fails with the wrong key or tampered data', () => {
    const payload = encryptSecret('secret', key);
    expect(() => decryptSecret(payload, Buffer.alloc(32, 4))).toThrow();
    const [v, iv, tag, data] = payload.split('.');
    const flipped = `${data!.slice(0, -1)}${data!.endsWith('A') ? 'B' : 'A'}`;
    expect(() => decryptSecret([v, iv, tag, flipped].join('.'), key)).toThrow();
  });

  it('rejects unknown formats and short keys', () => {
    expect(() => decryptSecret('v0.a.b.c', key)).toThrow('Unsupported encrypted secret format');
    expect(() => encryptSecret('x', Buffer.alloc(16))).toThrow('32 bytes');
  });

  it('rejects a truncated auth tag', () => {
    const [v, iv, tag, data] = encryptSecret('secret', key).split('.');
    const shortTag = Buffer.from(tag!, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => decryptSecret([v, iv, shortTag, data].join('.'), key)).toThrow();
  });

  it('rejects a payload with extra segments', () => {
    const payload = `${encryptSecret('secret', key)}.junk`;
    expect(() => decryptSecret(payload, key)).toThrow('Unsupported encrypted secret format');
  });

  it('rejects a short key when decrypting', () => {
    const payload = encryptSecret('secret', key);
    expect(() => decryptSecret(payload, Buffer.alloc(16, 3))).toThrow('32 bytes');
  });
});
