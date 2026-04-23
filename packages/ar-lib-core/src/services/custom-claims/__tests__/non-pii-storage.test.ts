import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../../db';
import { upsertUserCustomFieldValue } from '../non-pii-storage';

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
      'UPDATE user_custom_fields SET field_value = ?, field_type = ?, tenant_id = ? WHERE user_id = ? AND field_name = ?',
      ['Sales', 'string', 'tenant-1', 'user-1', 'department']
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
      'INSERT INTO user_custom_fields (user_id, field_name, field_value, field_type, tenant_id) VALUES (?, ?, ?, ?, ?)',
      ['user-1', 'department', 'Sales', 'string', 'tenant-1']
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
      'UPDATE user_custom_fields SET field_value = ?, field_type = ?, tenant_id = ? WHERE user_id = ? AND field_name = ?',
      ['Sales', 'string', 'tenant-1', 'user-1', 'department']
    );
    expect(adapter.execute).toHaveBeenNthCalledWith(
      2,
      'INSERT INTO user_custom_fields (user_id, field_name, field_value, field_type, tenant_id) VALUES (?, ?, ?, ?, ?)',
      ['user-1', 'department', 'Sales', 'string', 'tenant-1']
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
      'UPDATE user_custom_fields SET field_value = ?, field_type = ?, tenant_id = ? WHERE user_id = ? AND field_name = ?',
      ['Sales', 'string', 'tenant-1', 'user-1', 'department']
    );
    expect(adapter.execute).toHaveBeenNthCalledWith(
      2,
      'INSERT INTO user_custom_fields (user_id, field_name, field_value, field_type, tenant_id) VALUES (?, ?, ?, ?, ?)',
      ['user-1', 'department', 'Sales', 'string', 'tenant-1']
    );
    expect(adapter.execute).toHaveBeenNthCalledWith(
      3,
      'UPDATE user_custom_fields SET field_value = ?, field_type = ?, tenant_id = ? WHERE user_id = ? AND field_name = ?',
      ['Sales', 'string', 'tenant-1', 'user-1', 'department']
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
});
