import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../../db';
import {
  countUsersWithNonPiiCustomClaimData,
  countUsersWithPiiCustomClaimData,
  listNonPiiFieldUsage,
  countUsersWithNonPiiFieldData,
  deleteStoredCustomClaimData,
  renameStoredCustomClaimData,
} from '../storage-admin';

function createMockAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  };
}

describe('storage-admin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns non-PII counts and field usage', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query)
      .mockResolvedValueOnce([{ count: 3 }])
      .mockResolvedValueOnce([
        { field_name: 'department', count: 2 },
        { field_name: 'title', count: 1 },
      ])
      .mockResolvedValueOnce([{ count: 2 }]);

    await expect(countUsersWithNonPiiCustomClaimData(adapter, 'tenant-1')).resolves.toBe(3);
    await expect(listNonPiiFieldUsage(adapter, 'tenant-1')).resolves.toEqual([
      { fieldName: 'department', count: 2 },
      { fieldName: 'title', count: 1 },
    ]);
    await expect(countUsersWithNonPiiFieldData(adapter, 'tenant-1', 'department')).resolves.toBe(2);
  });

  it('returns approximate PII user counts', async () => {
    const piiAdapter = createMockAdapter();
    vi.mocked(piiAdapter.query).mockResolvedValueOnce([{ count: 7 }]);

    await expect(countUsersWithPiiCustomClaimData(piiAdapter, 'tenant-1')).resolves.toBe(7);
  });

  it('deletes non-PII field storage via shared helper', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.execute).mockResolvedValueOnce({ success: true, rowsAffected: 4 });

    const result = await deleteStoredCustomClaimData({
      db: adapter,
      tenantId: 'tenant-1',
      fieldKey: 'department',
      isPii: false,
    });

    expect(result).toEqual({
      affectedUsers: 4,
      processedUsers: 4,
      failedUsers: 0,
    });
    expect(adapter.execute).toHaveBeenCalledWith(
      'DELETE FROM user_custom_fields WHERE tenant_id = ? AND field_name = ?',
      ['tenant-1', 'department']
    );
  });

  it('renames PII field storage and tracks failures', async () => {
    const coreAdapter = createMockAdapter();
    const piiAdapter = createMockAdapter();
    vi.mocked(piiAdapter.query)
      .mockResolvedValueOnce([
        { id: 'user-1', custom_attributes_json: '{"old_key":"value"}' },
        { id: 'user-2', custom_attributes_json: '{bad-json' },
      ])
      .mockResolvedValueOnce([]);

    const result = await renameStoredCustomClaimData({
      db: coreAdapter,
      dbPii: piiAdapter,
      tenantId: 'tenant-1',
      oldKey: 'old_key',
      newKey: 'new_key',
      isPii: true,
      updatedAt: 123,
      piiBatchSize: 10,
    });

    expect(result).toEqual({
      affectedUsers: 1,
      processedUsers: 2,
      failedUsers: 1,
    });
    expect(piiAdapter.execute).toHaveBeenCalledWith(
      'UPDATE users_pii SET custom_attributes_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [JSON.stringify({ new_key: 'value' }), 123, 'user-1', 'tenant-1']
    );
  });
});
