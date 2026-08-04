import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  signTenantRuntimeRegistrySnapshot,
  type TenantRuntimeRegistrySnapshot,
} from '../../packages/ar-lib-core/src/services/tenant-runtime-registry-snapshot.js';
import {
  buildPhase0cFixtureInsertQueries,
  buildPhase0cIdentifierFixtureEntries,
  buildPhase0cRuntimeState,
  parsePhase0cIdentifierFixtureArgs,
  PHASE0C_FIXTURE_ROWS_PER_STATEMENT,
  type RuntimeShardAssignment,
  type RuntimeRoute,
} from './phase0c-identifier-fixture.js';

const RUN_ID = 'phase0c-20260731010203-abcdef';
const LOOKUP_SECRET = 'lookup-secret-that-is-at-least-thirty-two-bytes';
const OTP_SECRET = 'otp-secret-that-is-at-least-thirty-two-bytes';
const RUNTIME_NOW = Date.parse('2026-07-31T05:40:00.000Z');

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

const route: RuntimeRoute = {
  tenantId: 'default',
  routeGeneration: 3,
  projection: {
    schemaVersion: 1,
    accountRouteGeneration: 3,
    residencyPolicyId: 'default',
    targets: [
      {
        dataRole: 'tenant_core/default',
        residencyPartition: 'default',
        shardId: 'default-shard',
        bindingRef: 'TDB_DEFAULT_CORE',
        requiredBindingRouteGeneration: 7,
      },
    ],
  },
};

async function runtimeFixture() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const privateJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
  for (const key of [privateJwk, publicJwk]) {
    key.kid = 'phase0c-runtime-key';
    key.alg = 'EdDSA';
    key.use = 'sig';
  }
  const stores = [
    {
      role: 'tenant_core',
      shardGroup: 'default',
      bindingRef: 'TDB_DEFAULT',
      databaseId: 'db-default',
    },
    { role: 'tenant_core', shardGroup: 'users', bindingRef: 'TDB_USERS', databaseId: 'db-users' },
    { role: 'tenant_pii', shardGroup: 'default', bindingRef: 'TDB_PII', databaseId: 'db-pii' },
  ] as const;
  const snapshot = await signTenantRuntimeRegistrySnapshot(
    {
      version: 4,
      tenantId: 'default',
      snapshotScope: 'tenant',
      deploymentTarget: 'default',
      runtimeGeneration: 7,
      routeStatus: 'active',
      quarantineDenyGeneration: 0,
      backend: { provider: 'd1', resolver: 'control-plane' },
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 1 },
      publishedAt: '2026-07-31T05:30:00.000Z',
      expiresAt: '2026-07-31T06:00:00.000Z',
      stores: stores.map((store) => ({
        tenantId: 'default',
        role: store.role,
        dataRole:
          store.role === 'tenant_pii'
            ? ('tenant_pii' as const)
            : store.shardGroup === 'default'
              ? ('tenant_core/default' as const)
              : ('tenant_core/users' as const),
        residencyPolicyId: 'default',
        residencyPartition: 'default',
        shardId: `shard-${store.shardGroup}`,
        assignmentGeneration: 3,
        bindingRouteGeneration: 7,
        placementPolicyGeneration: 1,
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'default',
        generation: 3,
        runtimeGeneration: 7,
        schemaVersion: 1,
        shardGroup: store.shardGroup,
        shardIndex: 0,
        shardCount: 1,
        shardKeyStrategy: 'none',
        provider: 'd1',
        driver: 'd1',
        bindingRef: store.bindingRef,
        connectionRef: null,
        deploymentTarget: 'default',
        status: 'active',
        healthStatus: 'active',
        databaseId: store.databaseId,
        databaseName: `authrim-test-${store.shardGroup}`,
        regionHint: null,
        jurisdiction: null,
      })),
      metadata: {
        storeCount: 3,
        roles: ['tenant_core', 'tenant_pii'],
        signature: null,
        signatureKeyId: null,
      },
    } satisfies TenantRuntimeRegistrySnapshot,
    { privateJwk, keyId: 'phase0c-runtime-key' },
    '2026-07-31T05:30:00.000Z'
  );
  const shardAssignments: RuntimeShardAssignment[] = [
    {
      tenantId: 'default',
      dataRole: 'tenant_core/default',
      residencyPolicyId: 'default',
      residencyPartition: 'default',
      shardId: 'shard-default',
      routeGeneration: 3,
      bindingRef: 'TDB_DEFAULT',
      databaseId: 'db-default',
    },
    {
      tenantId: 'default',
      dataRole: 'tenant_core/users',
      residencyPolicyId: 'default',
      residencyPartition: 'default',
      shardId: 'shard-users',
      routeGeneration: 3,
      bindingRef: 'TDB_USERS',
      databaseId: 'db-users',
    },
    {
      tenantId: 'default',
      dataRole: 'tenant_pii',
      residencyPolicyId: 'default',
      residencyPartition: 'default',
      shardId: 'shard-pii',
      routeGeneration: 3,
      bindingRef: 'TDB_PII',
      databaseId: 'db-pii',
    },
  ];
  return {
    snapshot,
    snapshotJson: JSON.stringify(snapshot),
    generationJson: JSON.stringify({
      runtimeGeneration: 7,
      routeStatus: 'active',
      quarantineDenyGeneration: 0,
      publishedAt: '2026-07-31T05:30:00.000Z',
      expiresAt: '2026-08-07T05:30:00.000Z',
    }),
    verificationJwks: JSON.stringify({ keys: [publicJwk] }),
    shardAssignments,
    lockD1: Object.fromEntries(
      shardAssignments.map((assignment) => [
        assignment.bindingRef,
        { id: assignment.databaseId, name: assignment.shardId },
      ])
    ),
  };
}

describe('Phase 0c identifier fixture', () => {
  it('permits only explicit test prepare/cleanup with a temporary fixture path', () => {
    expect(
      parsePhase0cIdentifierFixtureArgs([
        '--env',
        'test',
        '--prepare',
        '--fixture',
        '/private/tmp/phase0c.json',
        '--confirm-test-data',
      ])
    ).toMatchObject({ env: 'test', mode: 'prepare' });
    expect(() =>
      parsePhase0cIdentifierFixtureArgs([
        '--env',
        'production',
        '--prepare',
        '--fixture',
        '/private/tmp/phase0c.json',
        '--confirm-test-data',
      ])
    ).toThrow('phase0c_test_environment_required');
    expect(() =>
      parsePhase0cIdentifierFixtureArgs([
        '--env',
        'test',
        '--prepare',
        '--fixture',
        './fixture.json',
        '--confirm-test-data',
      ])
    ).toThrow('phase0c_fixture_must_use_temporary_directory');
    expect(() =>
      parsePhase0cIdentifierFixtureArgs([
        '--env',
        'test',
        '--cleanup',
        '--fixture',
        '/private/tmp/phase0c.json',
      ])
    ).toThrow('phase0c_test_data_confirmation_required');
  });

  it('builds unique one-use challenges without retaining raw synthetic email', async () => {
    const assignments = new Map(
      Array.from({ length: 4096 }, (_, virtualBucket) => [
        virtualBucket,
        {
          virtualBucket,
          assignmentGeneration: 5,
          bindingRef: 'LOOKUP_DB',
          databaseId: 'lookup-database-id',
        },
      ])
    );
    const entries = await buildPhase0cIdentifierFixtureEntries({
      runId: RUN_ID,
      count: PHASE0C_FIXTURE_ROWS_PER_STATEMENT,
      lookupSecret: LOOKUP_SECRET,
      lookupGeneration: 4,
      otpSecret: OTP_SECRET,
      assignments,
      randomId: uuid,
    });
    expect(new Set(entries.map((entry) => entry.challengeId)).size).toBe(
      PHASE0C_FIXTURE_ROWS_PER_STATEMENT
    );
    expect(new Set(entries.map((entry) => entry.digest)).size).toBe(
      PHASE0C_FIXTURE_ROWS_PER_STATEMENT
    );
    expect(entries.every((entry) => entry.hmacKeyGeneration === 4)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('@phase0c.invalid');
    const expectedVerifier = createHmac('sha256', OTP_SECRET)
      .update(`discovery-otp-v1\0${entries[0]!.challengeId}\0${entries[0]!.code}`)
      .digest('hex');
    expect(entries[0]!.otpVerifier).toBe(expectedVerifier);

    const queries = buildPhase0cFixtureInsertQueries({
      runId: RUN_ID,
      entries,
      route,
      now: 1_700_000_000,
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]!.params).toHaveLength(96);
    expect(queries[1]!.params).toHaveLength(64);
    expect(queries.every((query) => (query.params?.length ?? 0) <= 100)).toBe(true);
    expect(queries[1]!.params).toContain(RUN_ID);
    expect(JSON.stringify(queries)).not.toContain('@phase0c.invalid');
  });

  it('fails closed when a digest bucket has no active assignment', async () => {
    await expect(
      buildPhase0cIdentifierFixtureEntries({
        runId: RUN_ID,
        count: 1,
        lookupSecret: LOOKUP_SECRET,
        lookupGeneration: 1,
        otpSecret: OTP_SECRET,
        assignments: new Map(),
        randomId: uuid,
      })
    ).rejects.toThrow('phase0c_lookup_assignment_missing');
  });

  it('derives the account route from the signed runtime registry and active shard inventory', async () => {
    const fixture = await runtimeFixture();
    const state = await buildPhase0cRuntimeState({
      tenantId: 'default',
      snapshotJson: fixture.snapshotJson,
      generationJson: fixture.generationJson,
      verificationJwks: fixture.verificationJwks,
      shardAssignments: fixture.shardAssignments,
      lockD1: fixture.lockD1,
      nowMs: RUNTIME_NOW,
    });
    expect(state.defaultDatabaseId).toBe('db-default');
    expect(state.route.projection.targets.map((target) => target.dataRole)).toEqual([
      'tenant_core/users',
      'tenant_pii',
    ]);
    expect(state.route.projection.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bindingRef: 'TDB_USERS', requiredBindingRouteGeneration: 3 }),
        expect.objectContaining({ bindingRef: 'TDB_PII', requiredBindingRouteGeneration: 3 }),
      ])
    );
  });

  it('rejects a tampered registry, stale generation, and wrong physical database mapping', async () => {
    const fixture = await runtimeFixture();
    const input = {
      tenantId: 'default',
      snapshotJson: fixture.snapshotJson,
      generationJson: fixture.generationJson,
      verificationJwks: fixture.verificationJwks,
      shardAssignments: fixture.shardAssignments,
      lockD1: fixture.lockD1,
      nowMs: RUNTIME_NOW,
    };
    const tampered = {
      ...fixture.snapshot,
      stores: fixture.snapshot.stores.map((store, index) =>
        index === 1 ? { ...store, databaseId: 'attacker-database' } : store
      ),
    };
    await expect(
      buildPhase0cRuntimeState({ ...input, snapshotJson: JSON.stringify(tampered) })
    ).rejects.toThrow('phase0c_runtime_snapshot_signature_invalid');
    await expect(
      buildPhase0cRuntimeState({
        ...input,
        generationJson: JSON.stringify({
          ...JSON.parse(fixture.generationJson),
          runtimeGeneration: 6,
        }),
      })
    ).rejects.toThrow('phase0c_runtime_generation_mismatch');
    await expect(
      buildPhase0cRuntimeState({
        ...input,
        lockD1: { ...fixture.lockD1, TDB_USERS: { id: 'wrong-db', name: 'wrong' } },
      })
    ).rejects.toThrow('phase0c_runtime_shard_assignment_invalid');
  });
});
