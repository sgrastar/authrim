import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { AdminStorageDestinationRepository } from '../admin/admin-storage-destination';

function adapter(): DatabaseAdapter {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => ({ success: true, rowsAffected: 1 })),
    batch: vi.fn(),
    transaction: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(() => 'd1'),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

function destination(overrides: Record<string, unknown> = {}) {
  return {
    id: 'destination-1',
    scope_type: 'tenant',
    scope_id: 'tenant-a',
    name: 'audit',
    display_name: 'Audit archive',
    description: null,
    provider: 'r2',
    config_json: '{"bucket":"audit"}',
    credential_encrypted: 'encrypted',
    credential_key_version: 2,
    credential_updated_at: 10,
    credential_updated_by: 'admin-1',
    status: 'active',
    created_by: 'admin-1',
    updated_by: 'admin-1',
    created_at: 1,
    updated_at: 2,
    is_active: 1,
    ...overrides,
  };
}

function usage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usage-1',
    destination_id: 'destination-1',
    feature: 'audit',
    resource_type: 'tenant',
    resource_id: 'tenant-a',
    tenant_id: 'tenant-a',
    metadata_json: '{"retention":30}',
    created_by: 'admin-1',
    created_at: 1,
    updated_at: 2,
    is_active: 1,
    ...overrides,
  };
}

describe('AdminStorageDestinationRepository', () => {
  it('creates tenant and platform destinations with normalized scope and credentials', async () => {
    const db = adapter();
    vi.mocked(db.queryOne)
      .mockResolvedValueOnce(destination())
      .mockResolvedValueOnce(
        destination({
          id: 'platform-1',
          scope_type: 'platform',
          scope_id: 'platform',
          name: 'shared',
          credential_encrypted: null,
        })
      );
    const repository = new AdminStorageDestinationRepository(db);
    await expect(
      repository.createDestination({
        scope_type: 'tenant',
        tenant_id: 'tenant-a',
        name: 'audit',
        display_name: 'Audit archive',
        provider: 'r2',
        config: { bucket: 'audit' },
        credential_encrypted: 'encrypted',
        credential_key_version: 2,
        credential_updated_by: 'admin-1',
        created_by: 'admin-1',
      })
    ).resolves.toMatchObject({ scope_id: 'tenant-a', has_credential: true });
    await expect(
      repository.createDestination({ scope_type: 'platform', name: 'shared', provider: 'custom' })
    ).resolves.toMatchObject({ scope_id: 'platform', has_credential: false });
    await expect(
      repository.createDestination({ scope_type: 'tenant', name: 'invalid', provider: 'r2' })
    ).rejects.toThrow('requires tenantId');
  });

  it('throws when an insert cannot be read back', async () => {
    await expect(
      new AdminStorageDestinationRepository(adapter()).createDestination({
        scope_type: 'platform',
        name: 'missing',
        provider: 'r2',
      })
    ).rejects.toThrow('Failed to create storage destination');
  });

  it('maps valid and malformed config in lists and credential reads', async () => {
    const db = adapter();
    vi.mocked(db.query)
      .mockResolvedValueOnce([destination(), destination({ id: 'bad', config_json: '[]' })])
      .mockResolvedValueOnce([destination({ config_json: '{' })]);
    vi.mocked(db.queryOne)
      .mockResolvedValueOnce(destination())
      .mockResolvedValueOnce(destination())
      .mockResolvedValueOnce(null);
    const repository = new AdminStorageDestinationRepository(db);
    await expect(repository.listByScope('tenant', 'tenant-a')).resolves.toEqual([
      expect.objectContaining({ config: { bucket: 'audit' } }),
      expect.objectContaining({ config: {} }),
    ]);
    await expect(repository.listUsableForTenant('tenant-a')).resolves.toEqual([
      expect.objectContaining({ config: {} }),
    ]);
    await expect(repository.getDestination('destination-1')).resolves.toMatchObject({
      has_credential: true,
    });
    await expect(repository.getDestinationWithCredential('destination-1')).resolves.toMatchObject({
      credential_encrypted: 'encrypted',
    });
    await expect(repository.getDestinationWithCredential('missing')).resolves.toBeNull();
  });

  it('updates only supplied metadata or returns the current destination for empty updates', async () => {
    const db = adapter();
    vi.mocked(db.queryOne)
      .mockResolvedValueOnce(destination({ display_name: 'Updated', status: 'disabled' }))
      .mockResolvedValueOnce(destination());
    const repository = new AdminStorageDestinationRepository(db);
    await expect(
      repository.updateDestination('destination-1', {
        display_name: 'Updated',
        description: null,
        config: { bucket: 'new' },
        status: 'disabled',
        updated_by: 'admin-2',
      })
    ).resolves.toMatchObject({ display_name: 'Updated', status: 'disabled' });
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('display_name = ?'),
      expect.arrayContaining(['Updated', null, '{"bucket":"new"}', 'disabled', 'admin-2'])
    );
    await repository.updateDestination('destination-1', {});
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('updates credential metadata with nullable actor', async () => {
    const db = adapter();
    vi.mocked(db.queryOne).mockResolvedValue(destination({ credential_key_version: 3 }));
    const repository = new AdminStorageDestinationRepository(db);
    await expect(
      repository.updateCredential('destination-1', {
        credential_encrypted: 'new',
        key_version: 3,
      })
    ).resolves.toMatchObject({ credential_key_version: 3 });
    expect(db.execute).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['new', 3, null])
    );
  });

  it('prevents deletion while active usage exists and maps delete outcomes', async () => {
    const db = adapter();
    vi.mocked(db.queryOne)
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce(null);
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const repository = new AdminStorageDestinationRepository(db);
    await expect(repository.deleteDestination('used')).rejects.toThrow(
      'storage_destination_in_use'
    );
    await expect(repository.deleteDestination('destination-1', 'admin-1')).resolves.toBe(true);
    await expect(repository.deleteDestination('missing')).resolves.toBe(false);
  });

  it('upserts usage, requires tenant context, and validates readback', async () => {
    const db = adapter();
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 });
    vi.mocked(db.query)
      .mockResolvedValueOnce([usage()])
      .mockResolvedValueOnce([usage({ metadata_json: 'null' })])
      .mockResolvedValueOnce([]);
    const repository = new AdminStorageDestinationRepository(db);
    const input = {
      destination_id: 'destination-1',
      feature: 'audit',
      resource_type: 'tenant',
      resource_id: 'tenant-a',
      tenant_id: 'tenant-a',
      metadata: { retention: 30 },
      created_by: 'admin-1',
    };
    await expect(repository.recordUsage(input)).resolves.toMatchObject({
      metadata: { retention: 30 },
    });
    await expect(repository.listUsage('destination-1')).resolves.toEqual([
      expect.objectContaining({ metadata: {} }),
    ]);
    await expect(repository.recordUsage(input)).rejects.toThrow('Failed to record');
    await expect(repository.recordUsage({ ...input, tenant_id: ' ' })).rejects.toThrow(
      'requires tenantId'
    );
  });

  it('uses empty metadata and a null actor when optional usage fields are omitted', async () => {
    const db = adapter();
    vi.mocked(db.execute).mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    vi.mocked(db.query).mockResolvedValueOnce([usage({ metadata_json: '{}', created_by: null })]);
    const repository = new AdminStorageDestinationRepository(db);
    await expect(
      repository.recordUsage({
        destination_id: 'destination-1',
        feature: 'audit',
        resource_type: 'tenant',
        resource_id: 'tenant-a',
        tenant_id: 'tenant-a',
      })
    ).resolves.toMatchObject({ metadata: {}, created_by: null });
    expect(db.execute).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.arrayContaining(['{}', null])
    );
  });
});
