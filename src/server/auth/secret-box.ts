import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>` (base64url parts); a fresh 96-bit IV every time. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [FORMAT_VERSION, iv, cipher.getAuthTag(), ciphertext].map((part) =>
    typeof part === 'string' ? part : part.toString('base64url'),
  ).join('.');
}

/** Reverses encryptSecret; throws if the payload was tampered with or the key is wrong. */
export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error('Unsupported encrypted secret format');
  }
  const [, ivPart, tagPart, ciphertext] = parts as [string, string, string, string];
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  // Pin the lengths: GCM would otherwise accept a truncated tag, weakening authentication.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Unsupported encrypted secret format');
  }
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
