import { describe, expect, it, vi } from 'vitest';
import { SqlLogChunkCatalogStore } from '../logging-catalog-store';

function createAdapter() {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    transaction: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SqlLogChunkCatalogStore writer leases', () => {
  it('persists a pending writer lease and restores it from the catalog row', async () => {
    const adapter = createAdapter();
    adapter.queryOne.mockResolvedValue({
      id: 'obj_stable',
      tenant_key: 'tk_123',
      log_type: 'audit',
      plane: 'archive',
      surface: null,
      object_key: 'logs/obj_stable.jsonl.gz',
      object_kind: 'chunk',
      status: 'pending',
      record_count: 1,
      byte_count: 0,
      checksum_sha256: null,
      compression: 'gzip_block',
      encryption_scope: 'tenant:tk_123:audit:archive',
      key_version: 1,
      created_at: 1_700_000_000_000,
      committed_at: 1_700_000_060_000,
    });
    const store = new SqlLogChunkCatalogStore(adapter);

    await expect(
      store.createPendingObject({
        id: 'obj_stable',
        tenantKey: 'tk_123',
        logType: 'audit',
        plane: 'archive',
        objectKey: 'logs/obj_stable.jsonl.gz',
        objectKind: 'chunk',
        status: 'pending',
        recordCount: 1,
        byteCount: 0,
        compression: 'gzip_block',
        encryptionScope: 'tenant:tk_123:audit:archive',
        keyVersion: 1,
        createdAt: 1_700_000_000_000,
        claimLeaseUntil: 1_700_000_060_000,
      })
    ).resolves.toBe(true);
    expect((adapter.execute.mock.calls[0]?.[1] as unknown[])[15]).toBe(1_700_000_060_000);
    await expect(store.getObject('obj_stable')).resolves.toEqual(
      expect.objectContaining({
        status: 'pending',
        claimLeaseUntil: 1_700_000_060_000,
        committedAt: undefined,
      })
    );
  });

  it('atomically reclaims only an expired pending writer lease', async () => {
    const adapter = createAdapter();
    const store = new SqlLogChunkCatalogStore(adapter);

    await expect(
      store.reclaimExpiredPendingObject('obj_stable', 1_700_000_060_001, 1_700_000_120_001)
    ).resolves.toBe(true);
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('(committed_at IS NULL OR committed_at <= ?)'),
      [1_700_000_120_001, 'obj_stable', 1_700_000_060_001]
    );
  });
});
