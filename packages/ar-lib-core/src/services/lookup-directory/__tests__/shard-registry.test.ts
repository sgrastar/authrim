import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  loadVerifiedLookupBucketAssignmentProvider,
  signLookupShardRegistry,
  VerifiedLookupBucketAssignmentProvider,
  verifyLookupShardRegistry,
  type LookupShardRegistryInput,
} from '../shard-registry';

const NOW = 1_800_000_000;
let privateJwk: JWK;
let publicJwk: JWK;

function registry(overrides: Partial<LookupShardRegistryInput> = {}): LookupShardRegistryInput {
  return {
    environmentId: 'test',
    generation: 3,
    issuedAt: NOW,
    expiresAt: NOW + 3600,
    ranges: [
      {
        startBucket: 0,
        endBucket: 2047,
        assignmentGeneration: 2,
        lookupShardId: 'lookup-a',
        bindingRef: 'LOOKUP_DB_A',
      },
      {
        startBucket: 2048,
        endBucket: 4095,
        assignmentGeneration: 4,
        lookupShardId: 'lookup-b',
        bindingRef: 'LOOKUP_DB_B',
      },
    ],
    ...overrides,
  };
}

describe('signed Lookup shard registry', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'registry-key-a', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'registry-key-a', alg: 'EdDSA' };
  });

  it('verifies a complete range registry and resolves one active assignment', async () => {
    const token = await signLookupShardRegistry({ registry: registry(), privateJwk });
    const verified = await verifyLookupShardRegistry({
      token,
      environmentId: 'test',
      publicJwks: { keys: [publicJwk] },
      now: NOW + 1,
    });
    const provider = new VerifiedLookupBucketAssignmentProvider(verified);
    const ranges = provider.listActiveRanges();
    ranges[0].lookupShardId = 'mutated';
    expect(provider.listActiveRanges()[0].lookupShardId).toBe('lookup-a');
    await expect(provider.resolveActiveAssignment(2048)).resolves.toEqual({
      virtualBucket: 2048,
      assignmentGeneration: 4,
      lookupShardId: 'lookup-b',
      bindingRef: 'LOOKUP_DB_B',
      state: 'active',
    });
  });

  it('rejects bucket gaps, overlaps, and incomplete coverage before signing', async () => {
    await expect(
      signLookupShardRegistry({
        registry: registry({
          ranges: [
            { ...registry().ranges[0], endBucket: 100 },
            { ...registry().ranges[1], startBucket: 102 },
          ],
        }),
        privateJwk,
      })
    ).rejects.toThrow('lookup_registry_bucket_coverage_invalid');
    await expect(
      signLookupShardRegistry({
        registry: registry({ ranges: [{ ...registry().ranges[0], endBucket: 4094 }] }),
        privateJwk,
      })
    ).rejects.toThrow('lookup_registry_bucket_coverage_invalid');
  });

  it('rejects tampering, unknown keys, wrong environments, and expiry', async () => {
    const token = await signLookupShardRegistry({ registry: registry(), privateJwk });
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${payload.startsWith('e') ? 'f' : 'e'}${payload.slice(1)}.${signature}`;
    await expect(
      verifyLookupShardRegistry({
        token: tampered,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: NOW,
      })
    ).rejects.toThrow('lookup_registry_signature_invalid');

    await expect(
      verifyLookupShardRegistry({
        token,
        environmentId: 'other',
        publicJwks: { keys: [publicJwk] },
        now: NOW,
      })
    ).rejects.toThrow('lookup_registry_claims_invalid');
    await expect(
      verifyLookupShardRegistry({
        token,
        environmentId: 'test',
        publicJwks: { keys: [{ ...publicJwk, kid: 'other-key' }] },
        now: NOW,
      })
    ).rejects.toThrow('lookup_registry_unknown_key');
    await expect(
      verifyLookupShardRegistry({
        token,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: NOW + 4000,
      })
    ).rejects.toThrow('lookup_registry_claims_invalid');
  });

  it('rejects private material in verification JWKS', async () => {
    const token = await signLookupShardRegistry({ registry: registry(), privateJwk });
    await expect(
      verifyLookupShardRegistry({
        token,
        environmentId: 'test',
        publicJwks: { keys: [privateJwk] },
        now: NOW,
      })
    ).rejects.toThrow('lookup_registry_public_jwks_private_material');
  });

  it('loads only a snapshot matching the separately published generation pointer', async () => {
    const token = await signLookupShardRegistry({ registry: registry(), privateJwk });
    const values = new Map([
      [buildLookupShardRegistrySnapshotKey('test'), token],
      [buildLookupShardRegistryGenerationKey('test'), '3'],
    ]);
    const provider = await loadVerifiedLookupBucketAssignmentProvider({
      store: { get: async (key) => values.get(key) ?? null },
      environmentId: 'test',
      publicJwks: { keys: [publicJwk] },
      now: NOW,
    });
    await expect(provider.resolveActiveAssignment(1)).resolves.toMatchObject({
      lookupShardId: 'lookup-a',
    });

    values.set(buildLookupShardRegistryGenerationKey('test'), '4');
    await expect(
      loadVerifiedLookupBucketAssignmentProvider({
        store: { get: async (key) => values.get(key) ?? null },
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: NOW,
      })
    ).rejects.toThrow('lookup_registry_generation_mismatch');
  });
});
