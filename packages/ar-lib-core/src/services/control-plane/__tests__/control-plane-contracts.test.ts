import { describe, expect, it } from 'vitest';
import {
  assertPublicVerificationJwk,
  assertThreeStateActivationGate,
  assertAccountDirectoryPublicationTransition,
  assertControlOperationTransition,
  assertControlPlaneRecordIsSecretFree,
  assertLookupLifecycleTransition,
  assertTenantShardWriteOwnership,
  validateTenantAliasRouteProjection,
  createD1ConsistencyRequest,
  deriveControlRegionShardAllowedRegions,
  nextDirectoryRewriteFencingToken,
  validateAccountDirectoryPublishRequest,
  validateAccountRouteProjection,
  validateControlAccountRouteAllocationResult,
  validateCrossShardAccountCursor,
} from '../control-plane-contracts.js';

describe('control-plane persistence safety', () => {
  it('accepts public metadata and blind digests', () => {
    expect(() =>
      assertControlPlaneRecordIsSecretFree({
        public_jwk_json: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) },
        public_key_fingerprint: 'sha256:public',
        email_blind_digest: 'digest',
        encrypted_config_ref: 'secret-store:item-id',
      })
    ).not.toThrow();
  });

  it('rejects provider credentials, private keys, raw email, and bearer values recursively', () => {
    for (const record of [
      { cloudflareApiToken: 'token' },
      { private_jwk: { d: 'private' } },
      { nested: { rawEmail: 'person@example.test' } },
      { desired_spec: { secretValue: 'secret' } },
      { harmless_key: '-----BEGIN PRIVATE KEY-----\nsecret' },
      { harmless_key: 'Bearer token-value' },
    ]) {
      expect(() => assertControlPlaneRecordIsSecretFree(record)).toThrow(
        /control_plane_sensitive_(?:key|value)_forbidden/u
      );
    }
  });

  it('accepts only public verification JWK members', () => {
    expect(() =>
      assertPublicVerificationJwk({
        kty: 'OKP',
        crv: 'Ed25519',
        x: 'A'.repeat(43),
        key_ops: ['verify'],
      })
    ).not.toThrow();
    expect(() =>
      assertControlPlaneRecordIsSecretFree({
        public_jwk_json: JSON.stringify({
          kty: 'OKP',
          crv: 'Ed25519',
          x: 'A'.repeat(43),
          d: 'private',
        }),
      })
    ).toThrow('control_plane_private_jwk_member_forbidden:$.public_jwk_json.d');
    expect(() =>
      assertPublicVerificationJwk({
        kty: 'OKP',
        crv: 'Ed25519',
        x: 'A'.repeat(43),
        key_ops: ['sign'],
      })
    ).toThrow('control_plane_public_jwk_key_ops_invalid:$.key_ops');
    expect(() => assertPublicVerificationJwk({ kty: 'RSA', n: 'modulus', e: 'AQAB' })).toThrow(
      'control_plane_public_jwk_ed25519_required:$'
    );
    expect(() =>
      assertPublicVerificationJwk({
        kty: 'OKP',
        crv: 'Ed25519',
        x: 'A'.repeat(43),
        alg: 'ES256',
      })
    ).toThrow('control_plane_public_jwk_alg_invalid:$.alg');
  });
});

describe('tenant region policy projection', () => {
  it('derives location, jurisdiction, and unrestricted region sets deterministically', () => {
    expect(
      deriveControlRegionShardAllowedRegions({ jurisdiction: null, locationHint: 'apac' })
    ).toEqual(['apac']);
    expect(
      deriveControlRegionShardAllowedRegions({ jurisdiction: 'eu', locationHint: null })
    ).toEqual(['weur', 'eeur']);
    expect(
      deriveControlRegionShardAllowedRegions({ jurisdiction: 'fedramp', locationHint: null })
    ).toEqual(['enam', 'wnam']);
    expect(
      deriveControlRegionShardAllowedRegions({ jurisdiction: null, locationHint: null })
    ).toEqual(['apac', 'weur', 'eeur', 'enam', 'wnam', 'oc', 'afr', 'me']);
  });

  it('rejects ambiguous placement inputs', () => {
    expect(() =>
      deriveControlRegionShardAllowedRegions({ jurisdiction: 'eu', locationHint: 'weur' })
    ).toThrow('control_tenant_region_shard_placement_ambiguous');
  });
});

describe('runtime route contracts', () => {
  const projection = {
    schemaVersion: 1,
    accountRouteGeneration: 3,
    residencyPolicyId: 'policy-1',
    targets: [
      {
        dataRole: 'tenant_core/users' as const,
        residencyPartition: 'default',
        shardId: 'shard-core-1',
        bindingRef: 'TEST_TDB_CORE_1',
        requiredBindingRouteGeneration: 4,
      },
      {
        dataRole: 'tenant_pii' as const,
        residencyPartition: 'default',
        shardId: 'shard-pii-1',
        bindingRef: 'TEST_TDB_PII_1',
        requiredBindingRouteGeneration: 4,
      },
    ],
  };

  it('validates one immutable target per role and residency partition', () => {
    expect(validateAccountRouteProjection(projection)).toBe(projection);
    expect(() =>
      validateAccountRouteProjection({
        ...projection,
        targets: [...projection.targets, projection.targets[0]],
      })
    ).toThrow('duplicate_route_target');
  });

  it('accepts only an exact, separated account allocation result', () => {
    const result = {
      tenantId: 'tenant-1',
      residencyPolicyId: 'policy-1',
      targets: [
        {
          allocationId: 'allocation-core',
          dataRole: 'tenant_core/users' as const,
          residencyPartition: 'default',
          shardId: 'shard-core-1',
          bindingRef: 'TEST_TDB_CORE_1',
          routeGeneration: 4,
        },
        {
          allocationId: 'allocation-pii',
          dataRole: 'tenant_pii' as const,
          residencyPartition: 'default',
          shardId: 'shard-pii-1',
          bindingRef: 'TEST_TDB_PII_1',
          routeGeneration: 5,
        },
      ],
    };
    const expected = {
      tenantId: 'tenant-1',
      residencyPolicyId: 'policy-1',
      residencyPartition: 'default',
      dataRoles: ['tenant_core/users', 'tenant_pii'] as const,
    };
    expect(validateControlAccountRouteAllocationResult(result, expected)).toEqual(result);
    expect(() =>
      validateControlAccountRouteAllocationResult(
        {
          ...result,
          targets: [result.targets[0], { ...result.targets[1], dataRole: 'tenant_core/users' }],
        },
        expected
      )
    ).toThrow('account_directory_allocation_role_invalid');
    expect(() =>
      validateControlAccountRouteAllocationResult(
        {
          ...result,
          targets: [result.targets[0], { ...result.targets[1], bindingRef: 'TEST_TDB_CORE_1' }],
        },
        expected
      )
    ).toThrow('account_directory_allocation_target_reused');
    expect(() =>
      validateControlAccountRouteAllocationResult(
        {
          ...result,
          targets: [result.targets[0], { ...result.targets[1], residencyPartition: 'eu' }],
        },
        expected
      )
    ).toThrow('account_directory_allocation_residency_mismatch');
    expect(() =>
      validateControlAccountRouteAllocationResult({ ...result, unexpected: true }, expected)
    ).toThrow('account_directory_allocation_invalid');
  });

  it('requires tenant, Registry, and Lookup to share the active generation', () => {
    const gate = {
      targetGeneration: 7,
      tenant: { state: 'active' as const, generation: 7 },
      runtimeRegistry: { state: 'active' as const, generation: 7 },
      lookup: { state: 'active' as const, generation: 7 },
    };
    expect(() => assertThreeStateActivationGate(gate)).not.toThrow();
    expect(() =>
      assertThreeStateActivationGate({
        ...gate,
        lookup: { state: 'active', generation: 6 },
      })
    ).toThrow('tenant_route_three_state_activation_gate_not_satisfied');
  });

  it('fixes the directory coordinator request and 201/202 operation identity inputs', () => {
    const request = {
      operationId: 'operation-1',
      tenantId: 'tenant-1',
      accountId: 'account-1',
      routeProjection: projection,
      idempotencyKey: 'account-create-1',
    };
    expect(validateAccountDirectoryPublishRequest(request)).toBe(request);
    expect(() =>
      validateAccountDirectoryPublishRequest({ ...request, tenantId: '../other' })
    ).toThrow('invalid_tenant_id');
  });

  it('rejects stale, cross-tenant, expired, and duplicate-shard cursors', () => {
    const cursor = {
      schemaVersion: 1 as const,
      tenantId: 'tenant-1',
      shardSetGeneration: 2,
      queryHash: 'a'.repeat(64),
      issuedAt: 100,
      expiresAt: 200,
      shardCursors: [{ shardId: 'shard-1', cursor: 'cursor-1' }],
    };
    const expected = {
      tenantId: 'tenant-1',
      shardSetGeneration: 2,
      queryHash: 'a'.repeat(64),
      now: 150,
    };
    expect(validateCrossShardAccountCursor(cursor, expected)).toBe(cursor);
    expect(() =>
      validateCrossShardAccountCursor(cursor, { ...expected, shardSetGeneration: 3 })
    ).toThrow('cursor_stale');
    expect(() =>
      validateCrossShardAccountCursor(cursor, { ...expected, queryHash: 'b'.repeat(64) })
    ).toThrow('cross_shard_cursor_query_mismatch');
    expect(() =>
      validateCrossShardAccountCursor(
        { ...cursor, shardCursors: [...cursor.shardCursors, cursor.shardCursors[0]] },
        expected
      )
    ).toThrow('duplicate_cursor_shard');
  });
});

describe('control-plane state transitions', () => {
  it('allows retries and blocks terminal operation rewrites', () => {
    expect(() => assertControlOperationTransition('queued', 'running')).not.toThrow();
    expect(() => assertControlOperationTransition('waiting_retry', 'running')).not.toThrow();
    expect(() => assertControlOperationTransition('blocked', 'running')).not.toThrow();
    expect(() => assertControlOperationTransition('blocked', 'canceled')).not.toThrow();
    expect(() => assertControlOperationTransition('succeeded', 'running')).toThrow(
      'invalid_control_operation_transition:succeeded:running'
    );
    expect(() => assertControlOperationTransition('canceled', 'running')).toThrow(
      'invalid_control_operation_transition:canceled:running'
    );
  });

  it('requires tenant and Runtime Registry activation before Lookup publication', () => {
    expect(() =>
      assertLookupLifecycleTransition('pending', 'active', {
        tenantActive: true,
        runtimeRouteActive: true,
      })
    ).not.toThrow();
    expect(() =>
      assertLookupLifecycleTransition('pending', 'active', {
        tenantActive: true,
        runtimeRouteActive: false,
      })
    ).toThrow('lookup_activation_gate_not_satisfied');
    expect(() =>
      assertLookupLifecycleTransition('disabled', 'active', {
        tenantActive: true,
        runtimeRouteActive: true,
      })
    ).toThrow('invalid_lookup_lifecycle_transition:disabled:active');
  });

  it('requires the authoritative account to pass through directory pending', () => {
    expect(() =>
      assertAccountDirectoryPublicationTransition('pending', 'active_pending_directory')
    ).not.toThrow();
    expect(() =>
      assertAccountDirectoryPublicationTransition('active_pending_directory', 'active')
    ).not.toThrow();
    expect(() => assertAccountDirectoryPublicationTransition('pending', 'active')).toThrow(
      'invalid_account_directory_transition:pending:active'
    );
  });
});

describe('D1 ownership and consistency contracts', () => {
  it('separates default metadata, user operational data, and PII writes', () => {
    expect(() =>
      assertTenantShardWriteOwnership('tenant_core/default', 'tenant_metadata')
    ).not.toThrow();
    expect(() => assertTenantShardWriteOwnership('tenant_core/users', 'account')).not.toThrow();
    expect(() => assertTenantShardWriteOwnership('tenant_pii', 'pii_profile')).not.toThrow();
    expect(() => assertTenantShardWriteOwnership('tenant_core/users', 'tenant_metadata')).toThrow();
    expect(() => assertTenantShardWriteOwnership('tenant_core/default', 'account')).toThrow();
    expect(() => assertTenantShardWriteOwnership('tenant_pii', 'credential')).toThrow();
  });

  it('allows tenant aliases to target only one generation-matched default shard', () => {
    const projection = {
      schemaVersion: 1,
      tenantRouteGeneration: 4,
      residencyPolicyId: 'default-policy',
      target: {
        dataRole: 'tenant_core/default' as const,
        residencyPartition: 'default',
        shardId: 'default-1',
        bindingRef: 'TEST_TDB_DEFAULT_1',
        requiredBindingRouteGeneration: 4,
      },
    };
    expect(validateTenantAliasRouteProjection(projection)).toEqual(projection);
    expect(() =>
      validateTenantAliasRouteProjection({
        ...projection,
        target: { ...projection.target, dataRole: 'tenant_core/users' as const },
      } as never)
    ).toThrow('invalid_tenant_alias_route_data_role');
    expect(() =>
      validateTenantAliasRouteProjection({
        ...projection,
        target: { ...projection.target, requiredBindingRouteGeneration: 5 },
      })
    ).toThrow('tenant_alias_route_generation_mismatch');
  });

  it('requires bookmarks only for read-after-write sessions', () => {
    expect(createD1ConsistencyRequest('replica_eligible')).toEqual({
      consistencyClass: 'replica_eligible',
      bookmark: null,
    });
    expect(createD1ConsistencyRequest('read_after_write', 'bookmark-1')).toEqual({
      consistencyClass: 'read_after_write',
      bookmark: 'bookmark-1',
    });
    expect(() => createD1ConsistencyRequest('read_after_write')).toThrow(
      'd1_read_after_write_bookmark_required'
    );
    expect(() => createD1ConsistencyRequest('primary_required', 'bookmark')).toThrow(
      'd1_bookmark_not_allowed_for:primary_required'
    );
  });
});

describe('directory rewrite fencing', () => {
  it('allows only same-operation takeover after mutation has started', () => {
    expect(
      nextDirectoryRewriteFencingToken({ current: null, nextOperationId: 'op-1', now: 10 })
    ).toBe(1);
    expect(() =>
      nextDirectoryRewriteFencingToken({
        current: {
          operationId: 'op-1',
          fencingToken: 4,
          leaseExpiresAt: 20,
          mutationStarted: false,
        },
        nextOperationId: 'op-2',
        now: 10,
      })
    ).toThrow('directory_rewrite_lease_active');
    expect(
      nextDirectoryRewriteFencingToken({
        current: { operationId: 'op-1', fencingToken: 4, leaseExpiresAt: 5, mutationStarted: true },
        nextOperationId: 'op-1',
        now: 10,
      })
    ).toBe(5);
    expect(() =>
      nextDirectoryRewriteFencingToken({
        current: { operationId: 'op-1', fencingToken: 4, leaseExpiresAt: 5, mutationStarted: true },
        nextOperationId: 'op-2',
        now: 10,
      })
    ).toThrow('directory_rewrite_cross_operation_takeover_forbidden_after_mutation');
  });
});
