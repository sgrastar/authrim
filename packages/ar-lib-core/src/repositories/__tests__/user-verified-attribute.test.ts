import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import { UserVerifiedAttributeRepository } from '../vc/user-verified-attribute';
import { AttributeVerificationRepository } from '../vc/attribute-verification';

function createMockAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  };
}

describe('UserVerifiedAttributeRepository', () => {
  it('updates an existing attribute without relying on ON CONFLICT', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce({
      id: 'attr-existing',
      created_at: 100,
    });
    vi.mocked(adapter.execute).mockResolvedValue({ success: true, rowsAffected: 1 });

    const repository = new UserVerifiedAttributeRepository(adapter);
    const result = await repository.upsertAttribute({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      attribute_name: 'department',
      attribute_value: 'engineering',
      source_type: 'manual',
    });

    expect(result.id).toBe('attr-existing');
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE user_verified_attributes'),
      expect.arrayContaining(['engineering', 'manual', 'attr-existing'])
    );
  });

  it('handles a unique-race by re-reading and updating the existing attribute', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'attr-raced',
      created_at: 200,
    });
    vi.mocked(adapter.execute)
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed'))
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 });

    const repository = new UserVerifiedAttributeRepository(adapter);
    const result = await repository.upsertAttribute({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      attribute_name: 'department',
      attribute_value: 'security',
      source_type: 'vc',
    });

    expect(result.id).toBe('attr-raced');
    expect(adapter.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO user_verified_attributes'),
      expect.arrayContaining(['tenant-1', 'user-1', 'department', 'security'])
    );
    expect(adapter.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE user_verified_attributes'),
      expect.arrayContaining(['security', 'vc', 'attr-raced'])
    );
  });

  it('fails closed when VC evidence is expired, stale, untrusted, revoked, or invalidated', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query).mockResolvedValue([]);
    const repository = new UserVerifiedAttributeRepository(adapter);

    await repository.getValidAttributesForUser('tenant-1', 'user-1');

    const [sql, params] = vi.mocked(adapter.query).mock.calls[0] ?? [];
    expect(sql).toContain("a.source_type <> 'vc'");
    expect(sql).toContain("v.verification_result = 'verified'");
    expect(sql).toContain('v.holder_binding_verified = 1');
    expect(sql).toContain('v.issuer_trusted = 1');
    expect(sql).toContain('v.status_valid = 1');
    expect(sql).toContain('v.invalidated_at IS NULL');
    expect(sql).toContain("ti.status = 'active'");
    expect(sql).toContain('v.status_fresh_until');
    expect(params).toHaveLength(7);
  });
});

describe('AttributeVerificationRepository', () => {
  it('persists pinned profile, mapping, freshness, and non-reversible evidence metadata', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.execute).mockResolvedValue({ success: true, rowsAffected: 1 });
    const repository = new AttributeVerificationRepository(adapter);

    await repository.createVerification({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      vp_request_id: 'vp-1',
      issuer_did: 'did:web:issuer.example',
      credential_type: 'AgeCredential',
      format: 'dc+sd-jwt',
      verification_result: 'verified',
      holder_binding_verified: true,
      issuer_trusted: true,
      status_valid: true,
      credential_profile_id: 'profile-1',
      credential_profile_version_id: 'profile-version-2',
      mapping_version_id: 'mapping-version-3',
      mapping_snapshot_hash: 'mapping-hash',
      policy_version: 'haip-1',
      evidence_fingerprint: 'hmac-fingerprint',
      status_checked_at: 1_000,
      status_fresh_until: 2_000,
      revalidate_after: 2_000,
      expires_at: 3_000,
    });

    const [sql, params] = vi.mocked(adapter.execute).mock.calls[0] ?? [];
    expect(sql).toContain('credential_profile_version_id');
    expect(sql).toContain('evidence_fingerprint');
    expect(params).toContain('hmac-fingerprint');
    expect(params).not.toContain('AgeCredential raw claim value');
  });
});
