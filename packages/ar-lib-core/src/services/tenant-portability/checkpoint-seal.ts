import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';

const INFO = new TextEncoder().encode('authrim-tenant-backup-checkpoint-v1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEALED = /^(?:[a-f0-9]{2})+$/;

function invalid(): never {
  throw new Error('backup_checkpoint_seal_invalid');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Seals checkpoint values derived from plaintext (hash midstates keep up to 63 unhashed bytes)
 * before they reach admin D1. The key is HKDF-derived from the backup content key with its own
 * label, so it never doubles as a stream key. `context` binds the value to the public fields
 * stored next to it, so a sealed value cannot be moved to another position.
 */
export interface TenantBackupCheckpointSeal {
  seal(value: string, context: string): Promise<string>;
  open(sealed: string, context: string): Promise<string>;
}

export async function openTenantBackupCheckpointSeal(
  session: TenantBundleKeyEnvelope,
  streamSalt: Uint8Array
): Promise<TenantBackupCheckpointSeal> {
  if (!(streamSalt instanceof Uint8Array) || streamSalt.length !== 32) invalid();
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(streamSalt), info: INFO },
    session.contentKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const encoder = new TextEncoder();
  return {
    async seal(value, context) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const encrypted = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: encoder.encode(context), tagLength: 128 },
          key,
          encoder.encode(value)
        )
      );
      const out = new Uint8Array(IV_BYTES + encrypted.length);
      out.set(iv);
      out.set(encrypted, IV_BYTES);
      return hex(out);
    },
    async open(sealed, context) {
      if (
        typeof sealed !== 'string' ||
        !SEALED.test(sealed) ||
        sealed.length < (IV_BYTES + TAG_BYTES) * 2
      )
        invalid();
      const bytes = Uint8Array.from(sealed.match(/../g) ?? [], (pair) => parseInt(pair, 16));
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: bytes.subarray(0, IV_BYTES),
              additionalData: encoder.encode(context),
              tagLength: 128,
            },
            key,
            bytes.subarray(IV_BYTES)
          )
        );
      } catch {
        invalid();
      }
    },
  };
}
