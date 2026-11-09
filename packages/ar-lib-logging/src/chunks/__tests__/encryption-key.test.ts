import { describe, expect, it } from 'vitest';
import { deriveLogChunkEncryptionKey } from '../encryption-key';

const ROOT_KEY = '00112233445566778899aabbccddeeff'.repeat(2);
const BASE = {
  rootKeyHex: ROOT_KEY,
  tenantKey: 'tenant-a',
  logType: 'audit' as const,
  plane: 'archive' as const,
  keyVersion: 3,
};

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('deriveLogChunkEncryptionKey', () => {
  it('matches a stable HKDF-SHA256 vector for the archive key domain', async () => {
    const derived = await deriveLogChunkEncryptionKey(BASE);
    expect(derived).toHaveLength(32);
    expect(hex(derived)).toBe('be660ef90819ee0293043d88ad6c9a2b65104c3008c466d1cecd58b273acbea7');
    expect(await deriveLogChunkEncryptionKey(BASE)).toEqual(derived);
    expect(
      await deriveLogChunkEncryptionKey({ ...BASE, rootKeyHex: ROOT_KEY.toUpperCase() })
    ).toEqual(derived);
  });

  it.each([
    { tenantKey: 'tenant-b' },
    { logType: 'security' as const },
    { plane: 'primary' as const },
    { keyVersion: 4 },
    { rootKeyHex: 'ff'.repeat(32) },
  ])('separates key material when a security boundary changes: %#', async (change) => {
    const first = await deriveLogChunkEncryptionKey(BASE);
    const second = await deriveLogChunkEncryptionKey({ ...BASE, ...change });
    expect(second).toHaveLength(32);
    expect(second).not.toEqual(first);
  });

  it.each(['', '00', '0'.repeat(63), '0'.repeat(65), 'g'.repeat(64), '00'.repeat(31) + 'zz'])(
    'rejects a malformed root secret before deriving an archive key: %s',
    async (rootKeyHex) => {
      await expect(deriveLogChunkEncryptionKey({ ...BASE, rootKeyHex })).rejects.toThrow(
        'object_encryption_root_key_invalid'
      );
    }
  );
});
