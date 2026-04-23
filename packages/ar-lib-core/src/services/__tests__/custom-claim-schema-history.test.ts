import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CustomClaimSchemaHistoryManager,
  calculateSchemaChanges,
} from '../custom-claim-schema-history';

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

describe('CustomClaimSchemaHistoryManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.query.mockResolvedValue([]);
    mockAdapter.queryOne.mockResolvedValue(null);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  });

  describe('calculateSchemaChanges', () => {
    it('detects added, removed, and modified keys', () => {
      const changes = calculateSchemaChanges(
        { keep: 'same', oldOnly: 'gone', update: 'before' },
        { keep: 'same', newOnly: 'added', update: 'after' }
      );

      expect(changes.added).toEqual(['newOnly']);
      expect(changes.removed).toEqual(['oldOnly']);
      expect(changes.modified).toEqual([
        { key: 'update', oldValue: 'before', newValue: 'after' },
      ]);
    });
  });

  describe('recordChange', () => {
    it('accepts a DatabaseAdapter source and records the next version', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce({ version: 2 });

      const manager = new CustomClaimSchemaHistoryManager(mockAdapter as any);
      const entry = await manager.recordChange({
        schemaId: 'schema-1',
        tenantId: 'tenant-1',
        operation: 'update',
        previousSnapshot: { field_key: 'department' },
        newSnapshot: { field_key: 'department_code' },
        actorId: 'admin-1',
        actorType: 'admin',
        changeSource: 'admin_api',
      });

      expect(entry.version).toBe(3);
      expect(entry.changes.modified).toEqual([
        {
          key: 'field_key',
          oldValue: 'department',
          newValue: 'department_code',
        },
      ]);
      expect(mockAdapter.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('SELECT MAX(version)'),
        ['tenant-1', 'schema-1']
      );
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO custom_claim_schema_history'),
        expect.arrayContaining(['tenant-1', 'schema-1', 3, 'update', 'admin-1', 'admin', 'admin_api'])
      );
    });
  });

  describe('listVersions', () => {
    it('returns parsed version summaries', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce({ total: 2 });
      mockAdapter.query.mockResolvedValueOnce([
        {
          version: 3,
          operation: 'rename',
          created_at: 1700000000,
          actor_id: 'admin-1',
          actor_type: 'admin',
          change_source: 'admin_api',
          changes: JSON.stringify({
            added: [],
            removed: [],
            modified: [{ key: 'field_key', oldValue: 'department', newValue: 'department_code' }],
          }),
        },
      ]);

      const manager = new CustomClaimSchemaHistoryManager(mockAdapter as any);
      const result = await manager.listVersions('tenant-1', 'schema-1', 10, 0);

      expect(result.total).toBe(2);
      expect(result.versions).toEqual([
        {
          version: 3,
          operation: 'rename',
          created_at: 1700000000,
          actor_id: 'admin-1',
          actor_type: 'admin',
          change_source: 'admin_api',
          changes_summary: {
            added: 0,
            removed: 0,
            modified: 1,
          },
        },
      ]);
    });
  });

  describe('getVersion', () => {
    it('returns null when the requested version does not exist', async () => {
      const manager = new CustomClaimSchemaHistoryManager(mockAdapter as any);
      await expect(manager.getVersion('tenant-1', 'schema-1', 99)).resolves.toBeNull();
    });

    it('returns the parsed snapshot for a specific version', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce({
        id: 'history-1',
        tenant_id: 'tenant-1',
        schema_id: 'schema-1',
        version: 4,
        operation: 'update',
        snapshot: JSON.stringify({ field_key: 'department_code' }),
        changes: JSON.stringify({
          added: [],
          removed: [],
          modified: [{ key: 'field_key', oldValue: 'department', newValue: 'department_code' }],
        }),
        actor_id: 'admin-1',
        actor_type: 'admin',
        change_source: 'admin_api',
        created_at: 1700000000,
      });

      const manager = new CustomClaimSchemaHistoryManager(mockAdapter as any);
      const result = await manager.getVersion('tenant-1', 'schema-1', 4);

      expect(result).toEqual({
        id: 'history-1',
        tenant_id: 'tenant-1',
        schema_id: 'schema-1',
        version: 4,
        operation: 'update',
        snapshot: { field_key: 'department_code' },
        changes: {
          added: [],
          removed: [],
          modified: [{ key: 'field_key', oldValue: 'department', newValue: 'department_code' }],
        },
        actor_id: 'admin-1',
        actor_type: 'admin',
        change_source: 'admin_api',
        created_at: 1700000000,
      });
    });
  });
});
