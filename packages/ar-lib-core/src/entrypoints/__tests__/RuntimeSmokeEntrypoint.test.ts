import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RuntimeSmokeEntrypoint } from '../RuntimeSmokeEntrypoint';
import { signRuntimeSmokeRequest } from '../../services/control-plane/runtime-smoke-rpc';
import { signRuntimeRegistrySnapshotPayloadJws } from '../../services/tenant-runtime-registry-snapshot';
import {
  buildLookupHmacKeyStateGenerationKey,
  buildLookupHmacKeyStateSnapshotKey,
  fingerprintLookupHmacKey,
  signLookupHmacKeyState,
} from '../../services/lookup-directory';

const NOW = Math.floor(Date.now() / 1000);
const BINDING = 'TDB_DEFAULT_1234_CORE';
let privateJwk: JWK;
let publicJwks: string;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'smoke-a', alg: 'EdDSA' };
  publicJwks = JSON.stringify({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'smoke-a', alg: 'EdDSA' }],
  });
});

function database() {
  const prepare = vi.fn((sql: string) => {
    const statement = {
      bind: () => statement,
      first: async () =>
        sql.includes('authrim_control_plane_shard_metadata')
          ? {
              binding_ref: BINDING,
              data_role: 'tenant_core/default',
              residency_partition: 'default',
              migration_generation: 1,
              release_id: 'release-1',
              manifest_digest: 'a'.repeat(64),
              expected_file_count: 33,
              last_filename: '033_control_plane_shard_metadata.sql',
            }
          : { applied_count: 33, last_filename_present: 1 },
    };
    return statement;
  });
  return { prepare };
}

function worker(overrides: Record<string, unknown> = {}) {
  return new RuntimeSmokeEntrypoint(
    {
      props: {
        caller: 'ar-control',
        audience: 'authrim-runtime-smoke-v1',
        environmentId: 'test',
        targetWorker: 'test-ar-auth',
      },
    } as ConstructorParameters<typeof RuntimeSmokeEntrypoint>[0],
    {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      AUTHRIM_WORKER_SCRIPT_NAME: 'test-ar-auth',
      CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS: publicJwks,
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: publicJwks,
      CONTROL_SMOKE_VERSION: {
        id: 'version-1',
        tag: 'smoke',
        timestamp: '2026-07-29T00:00:00.000Z',
      },
      [BINDING]: database(),
      ...overrides,
    }
  );
}

async function token(input: { operationId?: string; bindingRef?: string } = {}) {
  return signRuntimeSmokeRequest({
    keyId: 'smoke-a',
    privateJwk,
    now: NOW,
    request: {
      environmentId: 'test',
      operationId: input.operationId ?? 'op-1',
      attempt: 1,
      targetWorker: 'test-ar-auth',
      bindingRef: input.bindingRef ?? BINDING,
      expectedMigrationGeneration: 1,
      dataRole: 'tenant_core/default',
      residencyPartition: 'default',
    },
  });
}

describe('RuntimeSmokeEntrypoint', () => {
  it('has no public HTTP surface and returns narrow signed binding evidence', async () => {
    const entrypoint = worker();
    const response = entrypoint.fetch();
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(entrypoint.smokeTenantBinding(await token())).resolves.toMatchObject({
      bindingRef: BINDING,
      migrationGeneration: 1,
      observedVersionId: 'version-1',
    });
  });

  it('rejects mismatched generated identity before signature or D1 access', async () => {
    const binding = database();
    const entrypoint = worker({
      AUTHRIM_WORKER_SCRIPT_NAME: 'test-ar-token',
      [BINDING]: binding,
    });
    await expect(entrypoint.smokeTenantBinding(await token())).rejects.toThrow(
      'runtime_smoke_caller_unauthorized'
    );
    expect(binding.prepare).not.toHaveBeenCalled();
  });

  it('verifies smoke and Runtime Registry candidate test vectors without reading D1', async () => {
    const entrypoint = worker({ [BINDING]: undefined });
    await expect(
      entrypoint.verifyControlKeyCandidate({ purpose: 'smoke_rpc', token: await token() })
    ).resolves.toMatchObject({
      purpose: 'smoke_rpc',
      keyId: 'smoke-a',
      targetWorker: 'test-ar-auth',
    });

    const payload = new TextEncoder().encode('authrim-runtime-registry-key-verification');
    const registryToken = await signRuntimeRegistrySnapshotPayloadJws({
      payload,
      privateJwk,
      keyId: 'smoke-a',
    });
    await expect(
      entrypoint.verifyControlKeyCandidate({
        purpose: 'runtime_registry',
        token: registryToken,
        payload,
        keyId: 'smoke-a',
      })
    ).resolves.toMatchObject({
      purpose: 'runtime_registry',
      keyId: 'smoke-a',
      targetWorker: 'test-ar-auth',
    });
  });

  it('rejects unknown fields and a mismatched Runtime Registry payload', async () => {
    const entrypoint = worker();
    await expect(
      entrypoint.verifyControlKeyCandidate({
        purpose: 'smoke_rpc',
        token: await token(),
        extra: true,
      })
    ).rejects.toThrow('runtime_key_verification_input_invalid');

    const payload = new TextEncoder().encode('expected');
    const registryToken = await signRuntimeRegistrySnapshotPayloadJws({
      payload,
      privateJwk,
      keyId: 'smoke-a',
    });
    await expect(
      entrypoint.verifyControlKeyCandidate({
        purpose: 'runtime_registry',
        token: registryToken,
        payload: new TextEncoder().encode('tampered'),
        keyId: 'smoke-a',
      })
    ).rejects.toThrow('runtime_key_verification_registry_signature_invalid');
  });

  it('verifies both Lookup HMAC slots with the fixed non-PII blind-index vector', async () => {
    const currentSecret = 'A'.repeat(43);
    const candidateSecret = 'B'.repeat(43);
    const current = {
      generation: 1,
      keyId: 'lookup-v1',
      slot: 'A' as const,
      fingerprint: await fingerprintLookupHmacKey(currentSecret),
    };
    const candidate = {
      generation: 2,
      keyId: 'lookup-v2',
      slot: 'B' as const,
      fingerprint: await fingerprintLookupHmacKey(candidateSecret),
    };
    const entrypoint = worker({
      LOOKUP_HMAC_KEY_SLOT_A: currentSecret,
      LOOKUP_HMAC_KEY_SLOT_B: candidateSecret,
    });
    const lookupToken = await token({
      operationId: 'hmac-rotation-1',
      bindingRef: 'TDB_LOOKUP_HMAC_TEST',
    });

    const result = await entrypoint.verifyLookupHmacCandidate({
      purpose: 'lookup_hmac',
      operationId: 'hmac-rotation-1',
      testVector: 'authrim-control-lookup-hmac-v1',
      token: lookupToken,
      current,
      candidate,
    });
    expect(result).toMatchObject({
      ok: true,
      purpose: 'lookup_hmac',
      operationId: 'hmac-rotation-1',
      targetWorker: 'test-ar-auth',
      current,
      candidate,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected_lookup_hmac_verification_success');
    expect(result.current.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.candidate.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.current.digest).not.toBe(result.candidate.digest);
  });

  it('rejects a Lookup HMAC fingerprint mismatch and arbitrary oracle input', async () => {
    const currentSecret = 'A'.repeat(43);
    const candidateSecret = 'B'.repeat(43);
    const current = {
      generation: 1,
      keyId: 'lookup-v1',
      slot: 'A' as const,
      fingerprint: await fingerprintLookupHmacKey(currentSecret),
    };
    const candidate = {
      generation: 2,
      keyId: 'lookup-v2',
      slot: 'B' as const,
      fingerprint: 'f'.repeat(64),
    };
    const entrypoint = worker({
      LOOKUP_HMAC_KEY_SLOT_A: currentSecret,
      LOOKUP_HMAC_KEY_SLOT_B: candidateSecret,
    });
    const lookupToken = await token({
      operationId: 'hmac-rotation-1',
      bindingRef: 'TDB_LOOKUP_HMAC_TEST',
    });
    const input = {
      purpose: 'lookup_hmac',
      operationId: 'hmac-rotation-1',
      testVector: 'authrim-control-lookup-hmac-v1',
      token: lookupToken,
      current,
      candidate,
    };

    await expect(entrypoint.verifyLookupHmacCandidate(input)).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_lookup_hmac_verification_key_mismatch',
    });
    await expect(
      entrypoint.verifyLookupHmacCandidate({ ...input, testVector: 'chosen-input' })
    ).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_lookup_hmac_verification_input_invalid',
    });
  });

  it('observes the signed dual-write Lookup HMAC generation and both local slots', async () => {
    const currentSecret = 'B'.repeat(43);
    const previousSecret = 'A'.repeat(43);
    const current = {
      generation: 2,
      keyId: 'lookup-v2',
      slot: 'B' as const,
      fingerprint: await fingerprintLookupHmacKey(currentSecret),
    };
    const previous = {
      generation: 1,
      keyId: 'lookup-v1',
      slot: 'A' as const,
      fingerprint: await fingerprintLookupHmacKey(previousSecret),
    };
    const snapshot = await signLookupHmacKeyState({
      privateJwk,
      state: {
        environmentId: 'test',
        generation: 2,
        issuedAt: NOW,
        expiresAt: NOW + 300,
        rotationState: 'activation_dual_write',
        writeMode: 'dual_write',
        current,
        previous,
      },
    });
    const store = {
      get: vi.fn(async (key: string) => {
        if (key === buildLookupHmacKeyStateSnapshotKey('test')) return snapshot;
        if (key === buildLookupHmacKeyStateGenerationKey('test')) return '2';
        return null;
      }),
    };
    const entrypoint = worker({
      TENANT_RUNTIME_REGISTRY: store,
      LOOKUP_HMAC_KEY_SLOT_A: previousSecret,
      LOOKUP_HMAC_KEY_SLOT_B: currentSecret,
    });
    const lookupToken = await token({
      operationId: 'hmac-rotation-1',
      bindingRef: 'TDB_LOOKUP_HMAC_TEST',
    });

    await expect(
      entrypoint.observeLookupHmacGeneration({
        purpose: 'lookup_hmac_generation',
        operationId: 'hmac-rotation-1',
        token: lookupToken,
        current,
        previous,
      })
    ).resolves.toMatchObject({
      ok: true,
      purpose: 'lookup_hmac_generation',
      operationId: 'hmac-rotation-1',
      targetWorker: 'test-ar-auth',
      stateRevision: 2,
      current,
      previous,
    });
  });

  it('does not fall back to another D1 binding when the signed binding is absent', async () => {
    const fallback = database();
    const entrypoint = worker({ [BINDING]: undefined, DB: fallback });
    await expect(entrypoint.smokeTenantBinding(await token())).rejects.toThrow(
      'runtime_smoke_binding_unavailable'
    );
    expect(fallback.prepare).not.toHaveBeenCalled();
  });
});
