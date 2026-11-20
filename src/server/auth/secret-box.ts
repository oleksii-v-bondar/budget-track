import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const FORMAT_VERSION = 'v1';

/** AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>` (base64url parts); a fresh 96-bit IV every time. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [FORMAT_VERSION, iv, cipher.getAuthTag(), ciphertext].map((part) =>
    typeof part === 'string' ? part : part.toString('base64url'),
  ).join('.');
}

/** Reverses encryptSecret; throws if the payload was tampered with or the key is wrong. */
export function decryptSecret(payload: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== FORMAT_VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error('Unsupported encrypted secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
