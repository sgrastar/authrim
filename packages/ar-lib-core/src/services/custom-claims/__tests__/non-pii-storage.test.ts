import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../../db';
import { CustomFieldAccountRemovedError, upsertUserCustomFieldValue } from '../non-pii-storage';

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

describe('non-pii-storage', () => {
  it('updates an existing field without relying on UPSERT syntax', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.execute).mockResolvedValueOnce({ success: true, rowsAffected: 1 });

    await upsertUserCustomFieldValue({
      adapter,
      userId: 'user-1',
      tenantId: 'tenant-1',
      fieldName: 'department',
      fieldValue: 'Sales',
      fieldType: 'string',
    });

    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE user_custom_fields SET field_value = ?'),
      ['Sales', 'string', 'tenant-1', 'user-1', 'department', 'tenant-1', 'user-1']
    );
  });

  it('inserts a new field when no existing row is found', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 });

    await upsertUserCustomFieldValue({
      adapter,
      userId: 'user-1',
      tenantId: 'tenant-1',
      fieldName: 'department',
      fieldValue: 'Sales',
      fieldType: 'string',
    });

    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_custom_fields'),
      ['tenant-1', 'user-1', 'department', 'Sales', 'string', 'tenant-1', 'user-1']
    );
  });

  it('falls back to insert when update reports no matching row', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 });

    await upsertUserCustomFieldValue({
      adapter,
      userId: 'user-1',
      tenantId: 'tenant-1',
      fieldName: 'department',
      fieldValue: 'Sales',
      fieldType: 'string',
    });

    expect(adapter.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('UPDATE user_custom_fields SET field_value = ?'),
      ['Sales', 'string', 'tenant-1', 'user-1', 'department', 'tenant-1', 'user-1']
    );
    expect(adapter.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO user_custom_fields'),
      ['tenant-1', 'user-1', 'department', 'Sales', 'string', 'tenant-1', 'user-1']
    );
  });

  it('retries as update when insert loses a race to another writer', async () => {
    const adapter = createMockAdapter();
    const duplicateError = new Error('duplicate key');
    vi.mocked(adapter.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockRejectedValueOnce(duplicateError)
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 });

    await upsertUserCustomFieldValue({
      adapter,
      userId: 'user-1',
      tenantId: 'tenant-1',
      fieldName: 'department',
      fieldValue: 'Sales',
      fieldType: 'string',
    });

    expect(adapter.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('UPDATE user_custom_fields SET field_value = ?'),
      ['Sales', 'string', 'tenant-1', 'user-1', 'department', 'tenant-1', 'user-1']
    );
    expect(adapter.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO user_custom_fields'),
      ['tenant-1', 'user-1', 'department', 'Sales', 'string', 'tenant-1', 'user-1']
    );
    expect(adapter.execute).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('UPDATE user_custom_fields SET field_value = ?'),
      ['Sales', 'string', 'tenant-1', 'user-1', 'department', 'tenant-1', 'user-1']
    );
  });

  it('rethrows the original insert error when no row exists after failure', async () => {
    const adapter = createMockAdapter();
    const insertError = new Error('foreign key violation');
    vi.mocked(adapter.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockRejectedValueOnce(insertError)
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 });

    await expect(
      upsertUserCustomFieldValue({
        adapter,
        userId: 'user-1',
        tenantId: 'tenant-1',
        fieldName: 'department',
        fieldValue: 'Sales',
        fieldType: 'string',
      })
    ).rejects.toThrow(insertError);
  });

  it('writes nothing for an account being deleted (the guarded statements match no row)', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    vi.mocked(adapter.queryOne).mockResolvedValueOnce({ lifecycle_state: 'deleting' });

    await expect(
      upsertUserCustomFieldValue({
        adapter,
        userId: 'user-1',
        tenantId: 'tenant-1',
        fieldName: 'department',
        fieldValue: 'Sales',
        fieldType: 'string',
      })
    ).rejects.toBeInstanceOf(CustomFieldAccountRemovedError);
    // The guard is in the statements themselves (D1 runs them one at a time).
    expect(vi.mocked(adapter.execute).mock.calls[0][0]).toContain(
      "lifecycle_state IN ('deleting', 'deleted')"
    );
  });

  it('locks the account row for the write on PostgreSQL, refusing a removed account', async () => {
    const tx = { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() };
    const adapter = createMockAdapter();
    vi.mocked(adapter.getType).mockReturnValue('postgres');
    vi.mocked(adapter.transaction).mockImplementation(async (fn) => fn(tx as never));
    const write = () =>
      upsertUserCustomFieldValue({
        adapter,
        userId: 'user-1',
        tenantId: 'tenant-1',
        fieldName: 'department',
        fieldValue: 'Sales',
        fieldType: 'string',
      });

    tx.queryOne.mockResolvedValueOnce({ lifecycle_state: 'active' });
    tx.execute.mockResolvedValueOnce({ success: true, rowsAffected: 1 });
    await write();
    expect(String(tx.queryOne.mock.calls[0][0])).toContain('FOR SHARE');
    // One upsert statement (a duplicate key would fail the transaction).
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(String(tx.execute.mock.calls[0][0])).toContain(
      'ON CONFLICT (tenant_id, user_id, field_name)'
    );
    expect(tx.execute.mock.calls[0][1]).toEqual([
      'tenant-1',
      'user-1',
      'department',
      'Sales',
      'string',
    ]);

    tx.execute.mockClear();
    tx.queryOne.mockResolvedValueOnce({ lifecycle_state: 'deleted' });
    await expect(write()).rejects.toBeInstanceOf(CustomFieldAccountRemovedError);
    expect(tx.execute).not.toHaveBeenCalled();
  });
});
