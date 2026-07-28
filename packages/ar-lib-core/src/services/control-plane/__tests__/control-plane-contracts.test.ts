import { describe, expect, it } from 'vitest';
import {
  assertAccountDirectoryPublicationTransition,
  assertControlOperationTransition,
  assertControlPlaneRecordIsSecretFree,
  assertLookupLifecycleTransition,
  assertTenantShardWriteOwnership,
  createD1ConsistencyRequest,
  nextDirectoryRewriteFencingToken,
} from '../control-plane-contracts.js';

describe('control-plane persistence safety', () => {
  it('accepts public metadata and blind digests', () => {
    expect(() =>
      assertControlPlaneRecordIsSecretFree({
        public_jwk_json: { kty: 'OKP', crv: 'Ed25519', x: 'public' },
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
});

describe('control-plane state transitions', () => {
  it('allows retries and blocks terminal operation rewrites', () => {
    expect(() => assertControlOperationTransition('pending', 'running')).not.toThrow();
    expect(() => assertControlOperationTransition('waiting', 'running')).not.toThrow();
    expect(() => assertControlOperationTransition('blocked', 'running')).not.toThrow();
    expect(() => assertControlOperationTransition('succeeded', 'running')).toThrow(
      'invalid_control_operation_transition:succeeded:running'
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
