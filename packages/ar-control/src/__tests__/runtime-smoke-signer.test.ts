import { describe, expect, it } from 'vitest';
import { verifyRuntimeSmokeRequest } from '@authrim/ar-lib-core';
import { signControlRuntimeSmokeRequest } from '../runtime-smoke-signer';

async function keyPair(kid: string) {
  const generated = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  if (!('privateKey' in generated)) throw new Error('expected_crypto_key_pair');
  return {
    privateJwk: {
      ...(await crypto.subtle.exportKey('jwk', generated.privateKey)),
      kid,
      alg: 'EdDSA',
      use: 'sig',
    },
    publicJwk: {
      ...(await crypto.subtle.exportKey('jwk', generated.publicKey)),
      kid,
      alg: 'EdDSA',
      use: 'sig',
    },
  };
}

const request = {
  environmentId: 'test',
  operationId: 'operation-1',
  attempt: 1,
  targetWorker: 'test-ar-auth',
  bindingRef: 'TEST_TDB_CORE_001',
  expectedMigrationGeneration: 1,
  dataRole: 'tenant_core/default' as const,
  residencyPartition: 'global',
};

describe('Control runtime smoke signer', () => {
  it('selects slot A and produces a verifiable narrow request', async () => {
    const current = await keyPair('smoke-a');
    const token = await signControlRuntimeSmokeRequest({
      env: {
        SMOKE_RPC_SIGNING_JWK_SLOT_A: JSON.stringify(current.privateJwk),
        SMOKE_RPC_SIGNING_ACTIVE_SLOT: 'A',
        SMOKE_RPC_SIGNING_ACTIVE_KID: 'smoke-a',
      },
      request,
      now: 1_800_000_000,
    });

    await expect(
      verifyRuntimeSmokeRequest(token, {
        environmentId: 'test',
        targetWorker: 'test-ar-auth',
        publicJwks: { keys: [current.publicJwk] },
        now: 1_800_000_000,
      })
    ).resolves.toMatchObject({ bindingRef: 'TEST_TDB_CORE_001', attempt: 1 });
  });

  it('supports switching to slot B while retaining the previous public key', async () => {
    const previous = await keyPair('smoke-a');
    const current = await keyPair('smoke-b');
    const token = await signControlRuntimeSmokeRequest({
      env: {
        SMOKE_RPC_SIGNING_JWK_SLOT_A: JSON.stringify(previous.privateJwk),
        SMOKE_RPC_SIGNING_JWK_SLOT_B: JSON.stringify(current.privateJwk),
        SMOKE_RPC_SIGNING_ACTIVE_SLOT: 'B',
        SMOKE_RPC_SIGNING_ACTIVE_KID: 'smoke-b',
      },
      request: { ...request, attempt: 2 },
      now: 1_800_000_000,
    });

    await expect(
      verifyRuntimeSmokeRequest(token, {
        environmentId: 'test',
        targetWorker: 'test-ar-auth',
        publicJwks: { keys: [current.publicJwk, previous.publicJwk] },
        now: 1_800_000_000,
      })
    ).resolves.toMatchObject({ attempt: 2 });
  });

  it.each([
    {
      env: {
        SMOKE_RPC_SIGNING_JWK_SLOT_A: '{}',
        SMOKE_RPC_SIGNING_ACTIVE_SLOT: 'C',
        SMOKE_RPC_SIGNING_ACTIVE_KID: 'smoke-a',
      },
      error: 'control_smoke_active_slot_invalid',
    },
    {
      env: {
        SMOKE_RPC_SIGNING_JWK_SLOT_A: '{}',
        SMOKE_RPC_SIGNING_ACTIVE_SLOT: 'B',
        SMOKE_RPC_SIGNING_ACTIVE_KID: 'smoke-b',
      },
      error: 'control_smoke_active_slot_secret_missing',
    },
    {
      env: {
        SMOKE_RPC_SIGNING_JWK_SLOT_A: JSON.stringify({ kid: 'other' }),
        SMOKE_RPC_SIGNING_ACTIVE_SLOT: 'A',
        SMOKE_RPC_SIGNING_ACTIVE_KID: 'smoke-a',
      },
      error: 'control_smoke_active_key_id_mismatch',
    },
  ])('fails closed for partial or mismatched rotation state', async ({ env, error }) => {
    await expect(signControlRuntimeSmokeRequest({ env, request })).rejects.toThrow(error);
  });
});
