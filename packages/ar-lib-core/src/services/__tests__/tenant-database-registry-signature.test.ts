import { describe, expect, it } from 'vitest';
import type { TenantDatabaseRegistryRow } from '../../repositories/admin/tenant-database-registry';
import {
  loadTenantDatabaseRegistrySignatureKeysFromEnv,
  signTenantDatabaseRegistryRow,
  verifyTenantDatabaseRegistryRowSignature,
} from '../tenant-database-registry-signature';

function createRow(overrides: Partial<TenantDatabaseRegistryRow> = {}): TenantDatabaseRegistryRow {
  return {
    tenant_id: 'tenant-a',
    role: 'tenant_core',
    generation: 2,
    shard_group: 'default',
    shard_index: 0,
    provider: 'd1',
    database_id: 'db-id',
    database_name: 'authrim-dev-tenant-a-core',
    binding_ref: 'TDB_TENANT_A_CORE',
    connection_ref: null,
    schema_version: 2,
    status: 'active',
    shard_count: 1,
    shard_key_strategy: 'hash_user_id',
    worker_shard: 'primary',
    deployment_target: 'edge-a',
    region_hint: 'wnam',
    jurisdiction: 'us',
    signature: null,
    signature_key_id: null,
    metadata_json: null,
    created_at: '2026-05-16T00:00:00.000Z',
    updated_at: '2026-05-16T00:00:00.000Z',
    created_by: 'system',
    updated_by: 'system',
    ...overrides,
  };
}

describe('tenant database registry signatures', () => {
  it('signs and verifies routing-critical registry fields', async () => {
    const key = { keyId: 'registry-key-1', secret: 'secret-1' };
    const signed = await signTenantDatabaseRegistryRow(createRow(), key);
    const row = createRow({
      signature: signed.signature,
      signature_key_id: signed.signatureKeyId,
    });

    await expect(verifyTenantDatabaseRegistryRowSignature(row, [key])).resolves.toBe('valid');
    await expect(
      verifyTenantDatabaseRegistryRowSignature(createRow({ ...row, binding_ref: 'TAMPERED' }), [
        key,
      ])
    ).resolves.toBe('invalid');
  });

  it('supports current and previous signature keys from env', async () => {
    const keys = loadTenantDatabaseRegistrySignatureKeysFromEnv({
      TENANT_DATABASE_REGISTRY_SIGNATURE_SECRET: 'current-secret',
      TENANT_DATABASE_REGISTRY_SIGNATURE_KEY_ID: 'current',
      TENANT_DATABASE_REGISTRY_PREVIOUS_SIGNATURE_SECRET: 'previous-secret',
      TENANT_DATABASE_REGISTRY_PREVIOUS_SIGNATURE_KEY_ID: 'previous',
    });
    const signed = await signTenantDatabaseRegistryRow(createRow(), keys[1]);
    const row = createRow({
      signature: signed.signature,
      signature_key_id: signed.signatureKeyId,
    });

    expect(keys.map((key) => key.keyId)).toEqual(['current', 'previous']);
    await expect(verifyTenantDatabaseRegistryRowSignature(row, keys)).resolves.toBe('valid');
  });
});
