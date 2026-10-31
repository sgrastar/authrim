import { CompactEncrypt, exportJWK, exportPKCS8, generateKeyPair, importJWK } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { decryptRequestObject, RequestObjectDecryptionError } from '../request-object-encryption';

async function keyPair(kid: string) {
  const pair = await generateKeyPair('RSA-OAEP-256', { extractable: true });
  return {
    kid,
    publicJWK: { ...(await exportJWK(pair.publicKey)), kid, alg: 'RSA-OAEP-256', use: 'enc' },
    privatePEM: await exportPKCS8(pair.privateKey),
  };
}

function envWith(keys: Array<{ kid: string; privatePEM: string }>) {
  const getRequestObjectDecryptionKeyRpc = vi.fn(async (kid?: string) =>
    kid === undefined ? (keys[0] ?? null) : (keys.find((key) => key.kid === kid) ?? null)
  );
  return {
    env: {
      KEY_MANAGER: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ getRequestObjectDecryptionKeyRpc })),
      },
    } as unknown as Pick<Env, 'KEY_MANAGER'>,
    getRequestObjectDecryptionKeyRpc,
  };
}

async function encrypt(
  plaintext: string,
  jwk: Record<string, unknown>,
  header: { alg: string; enc: string; kid?: string }
) {
  return new CompactEncrypt(new TextEncoder().encode(plaintext))
    .setProtectedHeader(header)
    .encrypt(await importJWK(jwk, header.alg));
}

describe('decryptRequestObject', () => {
  it('decrypts with the key the kid names, from the tenant’s KeyManager', async () => {
    const key = await keyPair('enc-1');
    const { env, getRequestObjectDecryptionKeyRpc } = envWith([key]);
    for (const alg of ['RSA-OAEP-256', 'RSA-OAEP']) {
      const jwe = await encrypt('header.payload.signature', key.publicJWK, {
        alg,
        enc: 'A256GCM',
        kid: 'enc-1',
      });
      await expect(decryptRequestObject(env, 'tenant-a', jwe)).resolves.toBe(
        'header.payload.signature'
      );
    }
    expect(env.KEY_MANAGER.idFromName).toHaveBeenCalledWith('tenant-a-v3');
    expect(getRequestObjectDecryptionKeyRpc).toHaveBeenCalledWith('enc-1');
  });

  it('refuses an algorithm or key it does not decrypt with', async () => {
    const key = await keyPair('enc-1');
    const { env } = envWith([key]);
    const unknownKid = await encrypt('{}', key.publicJWK, {
      alg: 'RSA-OAEP-256',
      enc: 'A256GCM',
      kid: 'signing-key',
    });
    await expect(decryptRequestObject(env, 'tenant-a', unknownKid)).rejects.toMatchObject({
      reason: 'unsupported',
    });

    const ec = await generateKeyPair('ECDH-ES', { extractable: true });
    const ecdh = await new CompactEncrypt(new TextEncoder().encode('{}'))
      .setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM' })
      .encrypt(ec.publicKey);
    await expect(decryptRequestObject(env, 'tenant-a', ecdh)).rejects.toMatchObject({
      reason: 'unsupported',
    });
  });

  it('fails for a JWE encrypted to another key, and is unavailable without the KeyManager', async () => {
    const key = await keyPair('enc-1');
    const other = await keyPair('enc-1');
    const { env } = envWith([key]);
    const jwe = await encrypt('{}', other.publicJWK, { alg: 'RSA-OAEP-256', enc: 'A256GCM' });
    await expect(decryptRequestObject(env, 'tenant-a', jwe)).rejects.toMatchObject({
      reason: 'failed',
    });

    const failing = {
      KEY_MANAGER: {
        idFromName: () => 'id',
        get: () => ({
          getRequestObjectDecryptionKeyRpc: async () => {
            throw new Error('down');
          },
        }),
      },
    } as unknown as Pick<Env, 'KEY_MANAGER'>;
    const error = await decryptRequestObject(failing, 'tenant-a', jwe).catch((e) => e);
    expect(error).toBeInstanceOf(RequestObjectDecryptionError);
    expect(error.reason).toBe('unavailable');
  });
});
