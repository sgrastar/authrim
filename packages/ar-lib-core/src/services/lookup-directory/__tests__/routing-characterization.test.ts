import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LookupBlindIndex } from '../blind-index';
import { clearLookupRouteMemoryCache, LookupRouteResolver } from '../resolver';
import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  loadVerifiedLookupBucketAssignmentProvider,
  signLookupShardRegistry,
  verifyLookupShardRegistry,
  type LookupShardRegistryInput,
} from '../shard-registry';

const NOW = 1_800_000_000;
let privateJwk: JWK;
let publicJwk: JWK;

function index(virtualBucket: number, digestCharacter: string): LookupBlindIndex {
  return {
    indexKind: 'account_id',
    normalizationVersion: 1,
    hmacKeyGeneration: 1,
    digest: digestCharacter.repeat(64),
    virtualBucket,
  };
}

function row(input: LookupBlindIndex, tenantId: string, bindingRef: string) {
  return {
    virtual_bucket: input.virtualBucket,
    index_kind: input.indexKind,
    normalization_version: input.normalizationVersion,
    hmac_key_generation: input.hmacKeyGeneration,
    identifier_blind_digest: input.digest,
    tenant_id: tenantId,
    account_id: `account-${tenantId}`,
    route_schema_version: 1,
    account_route_generation: 3,
    required_binding_route_generation: 8,
    residency_policy_id: 'default-policy',
    route_projection_json: JSON.stringify({
      schemaVersion: 1,
      accountRouteGeneration: 3,
      residencyPolicyId: 'default-policy',
      targets: [
        {
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          shardId: `users-${tenantId}`,
          bindingRef,
          requiredBindingRouteGeneration: 8,
        },
      ],
    }),
    tenant_lifecycle_state: 'active',
    runtime_route_status: 'active',
    lifecycle_state: 'active',
  };
}

function database(rows: unknown[] = []): {
  binding: D1Database;
  withSession: ReturnType<typeof vi.fn>;
} {
  const session = {
    prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn(async () => ({ success: true, results: rows, meta: {} })),
    })),
    batch: vi.fn(),
    getBookmark: vi.fn(() => 'bookmark'),
  } as unknown as D1DatabaseSession;
  const withSession = vi.fn(() => session);
  return {
    binding: {
      prepare: vi.fn(),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
      withSession,
    } as unknown as D1Database,
    withSession,
  };
}

function registry(ranges: LookupShardRegistryInput['ranges']): LookupShardRegistryInput {
  return {
    environmentId: 'test',
    generation: 7,
    issuedAt: NOW,
    expiresAt: NOW + 3600,
    ranges,
  };
}

async function providerFor(input: LookupShardRegistryInput) {
  const token = await signLookupShardRegistry({ registry: input, privateJwk });
  return loadVerifiedLookupBucketAssignmentProvider({
    store: {
      get: async (key) => {
        if (key === buildLookupShardRegistrySnapshotKey('test')) return token;
        if (key === buildLookupShardRegistryGenerationKey('test')) return '7';
        return null;
      },
    },
    environmentId: 'test',
    publicJwks: { keys: [publicJwk] },
    now: NOW + 1,
  });
}

describe('current Lookup routing characterization', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'characterization-a', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'characterization-a', alg: 'EdDSA' };
  });

  beforeEach(() => clearLookupRouteMemoryCache());

  it('uses the same resolver API for one physical Lookup D1 and multiple physical Lookup D1s', async () => {
    const low = index(42, 'a');
    const high = index(3000, 'b');
    const one = database([row(low, 'tenant-a', 'TDB_USERS_A')]);
    const oneResolver = new LookupRouteResolver(
      { LOOKUP_A: one.binding },
      await providerFor(
        registry([
          {
            startBucket: 0,
            endBucket: 4095,
            assignmentGeneration: 1,
            lookupShardId: 'lookup-a',
            bindingRef: 'LOOKUP_A',
          },
        ])
      )
    );

    await expect(oneResolver.resolveMemberships({ indexes: [low] })).resolves.toMatchObject([
      { tenantId: 'tenant-a' },
    ]);
    expect(one.withSession).toHaveBeenCalledTimes(1);

    const lowDb = database([row(low, 'tenant-a', 'TDB_USERS_A')]);
    const highDb = database([row(high, 'tenant-b', 'TDB_USERS_B')]);
    const multipleResolver = new LookupRouteResolver(
      { LOOKUP_A: lowDb.binding, LOOKUP_B: highDb.binding },
      await providerFor(
        registry([
          {
            startBucket: 0,
            endBucket: 2047,
            assignmentGeneration: 2,
            lookupShardId: 'lookup-a',
            bindingRef: 'LOOKUP_A',
          },
          {
            startBucket: 2048,
            endBucket: 4095,
            assignmentGeneration: 3,
            lookupShardId: 'lookup-b',
            bindingRef: 'LOOKUP_B',
          },
        ])
      )
    );

    await expect(multipleResolver.resolveMemberships({ indexes: [low] })).resolves.toMatchObject([
      { tenantId: 'tenant-a' },
    ]);
    await expect(multipleResolver.resolveMemberships({ indexes: [high] })).resolves.toMatchObject([
      { tenantId: 'tenant-b' },
    ]);
    expect(lowDb.withSession).toHaveBeenCalledTimes(1);
    expect(highDb.withSession).toHaveBeenCalledTimes(1);
  });

  it('rejects registry tampering, cross-environment use, and a stale generation pointer', async () => {
    const input = registry([
      {
        startBucket: 0,
        endBucket: 4095,
        assignmentGeneration: 1,
        lookupShardId: 'lookup-a',
        bindingRef: 'LOOKUP_A',
      },
    ]);
    const token = await signLookupShardRegistry({ registry: input, privateJwk });
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${payload.startsWith('e') ? 'f' : 'e'}${payload.slice(1)}.${signature}`;

    await expect(
      verifyLookupShardRegistry({
        token: tampered,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: NOW + 1,
      })
    ).rejects.toThrow('lookup_registry_signature_invalid');
    await expect(
      verifyLookupShardRegistry({
        token,
        environmentId: 'other-environment',
        publicJwks: { keys: [publicJwk] },
        now: NOW + 1,
      })
    ).rejects.toThrow('lookup_registry_claims_invalid');
    await expect(
      loadVerifiedLookupBucketAssignmentProvider({
        store: {
          get: async (key) => (key === buildLookupShardRegistrySnapshotKey('test') ? token : '8'),
        },
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: NOW + 1,
      })
    ).rejects.toThrow('lookup_registry_generation_mismatch');
  });

  it('fails closed for stale binding generation and a wrong-namespace destination', async () => {
    const current = index(42, 'c');
    const lookup = database([row(current, 'tenant-a', 'TDB_USERS_A')]);
    const tenant = database();
    const resolver = new LookupRouteResolver(
      { LOOKUP_A: lookup.binding, TDB_USERS_A: tenant.binding },
      await providerFor(
        registry([
          {
            startBucket: 0,
            endBucket: 4095,
            assignmentGeneration: 1,
            lookupShardId: 'lookup-a',
            bindingRef: 'LOOKUP_A',
          },
        ])
      )
    );
    const membership = (await resolver.resolveMemberships({ indexes: [current] }))[0];

    expect(() =>
      resolver.resolveTarget({
        membership,
        dataRole: 'tenant_core/users',
        residencyPartition: 'default',
        observedBindingRouteGenerations: { TDB_USERS_A: 7 },
      })
    ).toThrow('lookup_route_binding_generation_stale');

    await expect(
      resolver.resolveTargetAndRevalidate({
        membership,
        dataRole: 'tenant_core/users',
        residencyPartition: 'default',
        observedBindingRouteGenerations: { TDB_USERS_A: 8 },
        verifyAtDestination: async (target) => target.membership.tenantId === 'tenant-b',
      })
    ).rejects.toThrow('lookup_destination_revalidation_failed');
  });
});
