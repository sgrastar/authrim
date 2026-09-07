import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../../db';
import {
  countUsersWithNonPiiCustomClaimData,
  countUsersWithPiiCustomClaimData,
  listNonPiiFieldUsage,
  countUsersWithNonPiiFieldData,
  countUsersWithPiiFieldData,
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

  it('counts PII users for one field-level value key', async () => {
    const piiAdapter = createMockAdapter();
    vi.mocked(piiAdapter.query).mockResolvedValueOnce([{ count: 2 }]);

    await expect(countUsersWithPiiFieldData(piiAdapter, 'tenant-1', 'tax_id')).resolves.toBe(2);
    expect(piiAdapter.query).toHaveBeenCalledWith(expect.stringContaining('value_key = ?'), [
      'tenant-1',
      'custom_attribute:tax_id',
    ]);
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
        { owner_id: 'user-1', value_json: '{"old_key":"value"}' },
        { owner_id: 'user-2', value_json: '{bad-json' },
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
    expect(piiAdapter.batch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining('DELETE FROM identity_sensitive_values'),
          params: ['tenant-1', 'user-1', 'custom_attribute:old_key'],
        }),
        expect.objectContaining({
          sql: expect.stringContaining('INSERT INTO identity_sensitive_values'),
          params: expect.arrayContaining([
            'tenant-1',
            'user-1',
            'custom_attribute:new_key',
            JSON.stringify('value'),
          ]),
        }),
        expect.objectContaining({
          sql: expect.stringContaining("value_key = 'custom_attributes_json'"),
          params: [JSON.stringify({ new_key: 'value' }), 123, 'tenant-1', 'user-1'],
        }),
      ])
    );
  });
});
