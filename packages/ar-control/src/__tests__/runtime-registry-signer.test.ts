import { describe, expect, it } from 'vitest';
import { verifyRuntimeRegistrySnapshotPayloadJws } from '@authrim/ar-lib-core';
import {
  runtimeRegistrySignerMetadata,
  signRuntimeRegistryPayload,
} from '../runtime-registry-signer';
import type { ControlEnv } from '../types';

type RuntimeRegistryPublicJwk = Parameters<
  typeof verifyRuntimeRegistrySnapshotPayloadJws
>[0]['keys'][number]['publicJwk'];

async function signingFixture(keyId = 'runtime-registry-a') {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('expected_crypto_key_pair');
  const privateJwk = {
    ...(await crypto.subtle.exportKey('jwk', pair.privateKey)),
    kid: keyId,
    alg: 'EdDSA',
    use: 'sig',
  };
  return {
    env: {
      RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT: 'A',
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: JSON.stringify(privateJwk),
      TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: keyId,
    } as ControlEnv,
    publicKey: pair.publicKey,
  };
}

describe('Control runtime registry signer', () => {
  it('returns public metadata and a verifiable Ed25519 signature', async () => {
    const { env, publicKey } = await signingFixture();
    const payload = new TextEncoder().encode('{"generation":7}');

    expect(runtimeRegistrySignerMetadata(env)).toEqual({
      keyId: 'runtime-registry-a',
      algorithm: 'EdDSA',
      type: 'authrim-runtime-registry+jws',
    });
    const result = await signRuntimeRegistryPayload(env, { payload });

    expect(result).toMatchObject({
      keyId: 'runtime-registry-a',
      algorithm: 'EdDSA',
      type: 'authrim-runtime-registry+jws',
    });
    const publicJwk = (await crypto.subtle.exportKey(
      'jwk',
      publicKey
    )) as RuntimeRegistryPublicJwk & {
      kid: string;
    };
    publicJwk.kid = 'runtime-registry-a';
    await expect(
      verifyRuntimeRegistrySnapshotPayloadJws({
        token: result.compactJws,
        payload,
        keys: [{ publicJwk }],
        expectedKeyId: 'runtime-registry-a',
      })
    ).resolves.toBe(true);
  });

  it.each([
    undefined,
    null,
    {},
    { payload: 'not-bytes' },
    { payload: new Uint8Array([1]), unexpected: true },
  ])('rejects malformed input %#', async (input) => {
    const { env } = await signingFixture();
    await expect(signRuntimeRegistryPayload(env, input)).rejects.toThrow(
      'runtime_registry_signing_input_invalid'
    );
  });

  it.each([new Uint8Array(), new Uint8Array(256 * 1024 + 1)])(
    'rejects an empty or oversized payload',
    async (payload) => {
      const { env } = await signingFixture();
      await expect(signRuntimeRegistryPayload(env, { payload })).rejects.toThrow(
        'runtime_registry_signing_payload_invalid'
      );
    }
  );

  it('rejects a mismatched active key id', async () => {
    const { env } = await signingFixture();
    env.TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID = 'different-key';

    await expect(signRuntimeRegistryPayload(env, { payload: new Uint8Array([1]) })).rejects.toThrow(
      'lookup_registry_signing_key_id_mismatch'
    );
  });
});
