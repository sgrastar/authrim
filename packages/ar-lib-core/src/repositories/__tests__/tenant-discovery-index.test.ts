import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, TransactionContext } from '../../db/adapter';
import {
  TenantDiscoveryIndexRepository,
  selectTenantDiscoveryPrimaryCandidate,
  type TenantDiscoveryIndexRow,
} from '../admin/tenant-discovery-index';

function createAdapter(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    transaction: vi.fn(async (fn: (tx: TransactionContext) => Promise<unknown>) =>
      fn({
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
      })
    ),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
    ...overrides,
  };
}

function createRow(overrides: Partial<TenantDiscoveryIndexRow> = {}): TenantDiscoveryIndexRow {
  return {
    tenant_id: 'tenant-a',
    subject_id: 'user-a',
    index_kind: 'email_domain',
    index_value: 'hash-domain',
    index_version: 1,
    key_version: 2,
    source_updated_at: '2026-05-16T00:00:00.000Z',
    indexed_at: '2026-05-16T00:01:00.000Z',
    status: 'active',
    metadata_json: null,
    ...overrides,
  };
}

describe('TenantDiscoveryIndexRepository', () => {
  it('upserts discovery index rows for current and previous key versions', async () => {
    const adapter = createAdapter();
    const repository = new TenantDiscoveryIndexRepository(adapter);

    await repository.upsertIndexForKeyVersions(
      {
        tenant_id: 'tenant-a',
        subject_id: 'user-a',
        index_kind: 'email_exact',
        index_value: 'hash-email',
        index_version: 1,
        source_updated_at: '2026-05-16T00:00:00.000Z',
        indexed_at: '2026-05-16T00:01:00.000Z',
      },
      [2, 1, 2]
    );

    expect(adapter.execute).toHaveBeenCalledTimes(2);
    expect(adapter.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO tenant_discovery_indexes'),
      expect.arrayContaining(['tenant-a', 'user-a', 'email_exact', 'hash-email', 1, 1])
    );
    expect(adapter.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO tenant_discovery_indexes'),
      expect.arrayContaining(['tenant-a', 'user-a', 'email_exact', 'hash-email', 1, 2])
    );
  });

  it('returns candidate sets for multiple matching tenants and no primary by default policy', async () => {
    const adapter = createAdapter({
      query: vi
        .fn()
        .mockResolvedValue([
          createRow({ tenant_id: 'tenant-a' }),
          createRow({ tenant_id: 'tenant-b', subject_id: 'user-b' }),
        ]),
    });
    const repository = new TenantDiscoveryIndexRepository(adapter);

    const result = await repository.resolveCandidateSet({
      indexKind: 'email_domain',
      indexValues: ['hash-domain'],
      keyVersions: [2, 1],
      selectionPolicy: 'select_if_multiple',
    });

    expect(result.result).toBe('multiple');
    expect(result.candidates.map((candidate) => candidate.tenant_id)).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
    expect(result.primary).toBeNull();
    expect(adapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM tenant_discovery_indexes'),
      ['email_domain', 'hash-domain', 1, 2, 1, 'active', 'rotating', 25]
    );
  });

  it('selects a primary candidate according to login entry selection policy', () => {
    const candidates = [
      createRow({ tenant_id: 'tenant-a' }),
      createRow({ tenant_id: 'tenant-b', subject_id: 'user-b' }),
    ];

    expect(selectTenantDiscoveryPrimaryCandidate(candidates, 'select_if_multiple')).toBeNull();
    expect(selectTenantDiscoveryPrimaryCandidate(candidates.slice(0, 1), 'auto_if_single')).toBe(
      candidates[0]
    );
    expect(selectTenantDiscoveryPrimaryCandidate(candidates, 'always_select')).toBe(candidates[0]);
    expect(selectTenantDiscoveryPrimaryCandidate(candidates, 'manual_only')).toBeNull();
  });

  it('deletes previous key rows only after current-key rows exist', async () => {
    const adapter = createAdapter();
    const repository = new TenantDiscoveryIndexRepository(adapter);

    const deleted = await repository.deletePreviousKeyVersionRows({
      indexKind: 'email_domain',
      previousKeyVersion: 1,
      currentKeyVersion: 2,
    });

    expect(deleted).toBe(1);
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM tenant_discovery_indexes'),
      ['email_domain', 1, 1, 2]
    );
  });

  it('counts previous key rows by reindex validation state', async () => {
    const adapter = createAdapter({
      queryOne: vi
        .fn()
        .mockResolvedValueOnce({ count: 12 })
        .mockResolvedValueOnce({ count: 10 })
        .mockResolvedValueOnce({ count: 2 }),
    });
    const repository = new TenantDiscoveryIndexRepository(adapter);

    await expect(
      repository.countPreviousKeyVersionRows({
        indexKind: 'email_exact',
        previousKeyVersion: 1,
      })
    ).resolves.toBe(12);
    await expect(
      repository.countPreviousKeyVersionRowsReadyForDeletion({
        indexKind: 'email_exact',
        previousKeyVersion: 1,
        currentKeyVersion: 2,
      })
    ).resolves.toBe(10);
    await expect(
      repository.countPreviousKeyVersionRowsMissingCurrent({
        indexKind: 'email_exact',
        previousKeyVersion: 1,
        currentKeyVersion: 2,
      })
    ).resolves.toBe(2);

    expect(adapter.queryOne).toHaveBeenCalledTimes(3);
  });
});
