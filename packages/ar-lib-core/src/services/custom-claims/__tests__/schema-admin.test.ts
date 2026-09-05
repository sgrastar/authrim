import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteCustomClaimSchemaById,
  findActiveCustomClaimSchemaByFieldKey,
  getCustomClaimSchemaById,
  insertCustomClaimSchema,
  listCustomClaimSchemas,
  updateCustomClaimSchemaFields,
} from '../schema-admin';

const mockAdapter = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  batch: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn().mockReturnValue('mock'),
  close: vi.fn(),
};

describe('schema-admin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.getType.mockReturnValue('mock');
    mockAdapter.query.mockResolvedValue([]);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  });

  it('lists schemas with filters and pagination', async () => {
    mockAdapter.query
      .mockResolvedValueOnce([{ count: 2 }])
      .mockResolvedValueOnce([{ id: 'schema-1' }, { id: 'schema-2' }]);

    const result = await listCustomClaimSchemas(mockAdapter as any, {
      tenantId: 'tenant-1',
      search: 'dept',
      fieldType: 'string',
      isPii: 0,
      isActive: 1,
      isSystem: 0,
      operationStatus: 'active',
      limit: 20,
      offset: 0,
    });

    expect(result.total).toBe(2);
    expect(result.schemas).toEqual([{ id: 'schema-1' }, { id: 'schema-2' }]);
    expect(mockAdapter.query.mock.calls[0][0]).toContain(
      'COUNT(*) as count FROM custom_claim_schemas'
    );
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([
      'tenant-1',
      '%dept%',
      '%dept%',
      '%dept%',
      'string',
      0,
      1,
      0,
      'active',
    ]);
  });

  it('fetches a schema by id', async () => {
    mockAdapter.query.mockResolvedValueOnce([{ id: 'schema-1' }]);

    await expect(
      getCustomClaimSchemaById(mockAdapter as any, 'tenant-1', 'schema-1')
    ).resolves.toEqual({
      id: 'schema-1',
    });
  });

  it('finds an active schema by field key with optional exclusion', async () => {
    mockAdapter.query.mockResolvedValueOnce([{ id: 'schema-1' }]);

    await expect(
      findActiveCustomClaimSchemaByFieldKey(mockAdapter as any, 'tenant-1', 'department', {
        excludeSchemaId: 'schema-2',
      })
    ).resolves.toEqual({ id: 'schema-1' });
    expect(mockAdapter.query).toHaveBeenCalledWith(expect.stringContaining('id != ?'), [
      'tenant-1',
      'department',
      'schema-2',
    ]);
  });

  it('inserts a schema row from a field map', async () => {
    await insertCustomClaimSchema(mockAdapter as any, {
      id: 'schema-1',
      tenant_id: 'tenant-1',
      field_key: 'department',
      display_label: 'Department',
    });

    expect(mockAdapter.execute).toHaveBeenCalledWith(expect.stringContaining('active_field_key'), [
      'schema-1',
      'tenant-1',
      'department',
      'Department',
      'department',
    ]);
  });

  it('uses native PostgreSQL booleans and normalizes returned flags', async () => {
    mockAdapter.getType.mockReturnValue('postgres');
    mockAdapter.query
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([
        { id: 'schema-1', is_pii: true, is_required: false, is_active: true, is_system: true },
      ]);

    const listed = await listCustomClaimSchemas(mockAdapter as any, {
      tenantId: 'tenant-1',
      isPii: 1,
      isActive: 1,
      isSystem: 1,
      limit: 20,
      offset: 0,
    });

    expect(mockAdapter.query.mock.calls[0][1]).toEqual(['tenant-1', true, true, true]);
    expect(listed.schemas).toEqual([
      { id: 'schema-1', is_pii: 1, is_required: 0, is_active: 1, is_system: 1 },
    ]);

    await insertCustomClaimSchema(mockAdapter as any, {
      id: 'schema-2',
      tenant_id: 'tenant-1',
      field_key: 'department',
      display_label: 'Department',
      is_pii: 1,
      is_required: 0,
      is_active: 1,
    });
    expect(mockAdapter.execute.mock.calls.at(-1)?.[1]).toEqual([
      'schema-2',
      'tenant-1',
      'department',
      'Department',
      true,
      false,
      true,
      'department',
    ]);
  });

  it('updates schema fields with optional status guard and version increment', async () => {
    mockAdapter.query.mockResolvedValueOnce([{ field_key: 'department', is_active: 1 }]);

    await expect(
      updateCustomClaimSchemaFields({
        db: mockAdapter as any,
        tenantId: 'tenant-1',
        schemaId: 'schema-1',
        updates: {
          field_key: 'department_code',
          operation_status: 'active',
          operation_detail: null,
          updated_at: 1700000000,
        },
        allowedCurrentStatuses: ['renaming'],
        incrementSchemaVersion: true,
      })
    ).resolves.toBe(1);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('schema_version = schema_version + 1'),
      [
        'department_code',
        'active',
        null,
        1700000000,
        'department_code',
        'schema-1',
        'tenant-1',
        'renaming',
      ]
    );
  });

  it('deletes a schema row by id', async () => {
    await expect(
      deleteCustomClaimSchemaById(mockAdapter as any, 'tenant-1', 'schema-1')
    ).resolves.toBe(1);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      'DELETE FROM custom_claim_schemas WHERE id = ? AND tenant_id = ?',
      ['schema-1', 'tenant-1']
    );
  });
});
