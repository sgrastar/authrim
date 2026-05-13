/**
 * Settings History Manager Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SettingsHistoryManager,
  calculateChanges,
  createSettingsHistoryManager,
  type SettingsChanges,
} from '../settings-history';

// Mock D1 database
const createMockD1 = () => {
  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockStmt),
    batch: vi.fn(),
  };
};

describe('SettingsHistoryManager', () => {
  let mockDb: ReturnType<typeof createMockD1>;
  let manager: SettingsHistoryManager;

  beforeEach(() => {
    mockDb = createMockD1();
    manager = createSettingsHistoryManager(mockDb as unknown as D1Database, 'test-tenant');
  });

  describe('calculateChanges', () => {
    it('should detect added keys', () => {
      const oldSnapshot = { key1: 'value1' };
      const newSnapshot = { key1: 'value1', key2: 'value2' };

      const changes = calculateChanges(oldSnapshot, newSnapshot);

      expect(changes.added).toEqual(['key2']);
      expect(changes.removed).toEqual([]);
      expect(changes.modified).toEqual([]);
    });

    it('should detect removed keys', () => {
      const oldSnapshot = { key1: 'value1', key2: 'value2' };
      const newSnapshot = { key1: 'value1' };

      const changes = calculateChanges(oldSnapshot, newSnapshot);

      expect(changes.added).toEqual([]);
      expect(changes.removed).toEqual(['key2']);
      expect(changes.modified).toEqual([]);
    });

    it('should detect modified keys', () => {
      const oldSnapshot = { key1: 'value1', key2: 'value2' };
      const newSnapshot = { key1: 'value1', key2: 'newValue' };

      const changes = calculateChanges(oldSnapshot, newSnapshot);

      expect(changes.added).toEqual([]);
      expect(changes.removed).toEqual([]);
      expect(changes.modified).toEqual([{ key: 'key2', oldValue: 'value2', newValue: 'newValue' }]);
    });

    it('should detect all types of changes', () => {
      const oldSnapshot = { keep: 'same', modify: 'old', remove: 'gone' };
      const newSnapshot = { keep: 'same', modify: 'new', add: 'added' };

      const changes = calculateChanges(oldSnapshot, newSnapshot);

      expect(changes.added).toEqual(['add']);
      expect(changes.removed).toEqual(['remove']);
      expect(changes.modified).toEqual([{ key: 'modify', oldValue: 'old', newValue: 'new' }]);
    });

    it('should handle nested objects', () => {
      const oldSnapshot = { nested: { a: 1, b: 2 } };
      const newSnapshot = { nested: { a: 1, b: 3 } };

      const changes = calculateChanges(oldSnapshot, newSnapshot);

      expect(changes.modified.length).toBe(1);
      expect(changes.modified[0].key).toBe('nested');
    });

    it('should handle empty snapshots', () => {
      const changes = calculateChanges({}, {});

      expect(changes.added).toEqual([]);
      expect(changes.removed).toEqual([]);
      expect(changes.modified).toEqual([]);
    });
  });

  describe('recordChange', () => {
    it('should create a new version record', async () => {
      // Mock getting the last version
      const mockStmt = mockDb.prepare();
      mockStmt.first.mockResolvedValueOnce({ version: 5 });
      mockStmt.run.mockResolvedValueOnce({ success: true });
      // Mock cleanup query
      mockStmt.run.mockResolvedValueOnce({ success: true });
      mockStmt.run.mockResolvedValueOnce({ success: true });

      const result = await manager.recordChange({
        category: 'oauth',
        previousSnapshot: { key1: 'old' },
        newSnapshot: { key1: 'new' },
        actorId: 'admin-1',
        actorType: 'admin',
        changeReason: 'Test change',
        changeSource: 'admin_api',
      });

      expect(result.version).toBe(6);
      expect(result.category).toBe('oauth');
      expect(result.actorId).toBe('admin-1');
      expect(result.changes.modified.length).toBe(1);
    });

    it('should start at version 1 if no previous versions', async () => {
      const mockStmt = mockDb.prepare();
      mockStmt.first.mockResolvedValueOnce({ version: null });
      mockStmt.run.mockResolvedValueOnce({ success: true });
      mockStmt.run.mockResolvedValueOnce({ success: true });
      mockStmt.run.mockResolvedValueOnce({ success: true });

      const result = await manager.recordChange({
        category: 'oauth',
        previousSnapshot: {},
        newSnapshot: { key1: 'value' },
      });

      expect(result.version).toBe(1);
    });
  });

  describe('listVersions', () => {
    it('should return paginated version list', async () => {
      const mockStmt = mockDb.prepare();
      // Count query
      mockStmt.first.mockResolvedValueOnce({ count: 15 });
      // List query
      mockStmt.all.mockResolvedValueOnce({
        results: [
          {
            version: 10,
            created_at: 1700000000,
            actor_id: 'admin-1',
            actor_type: 'admin',
            change_source: 'admin_api',
            change_reason: 'Update',
            changes: JSON.stringify({ added: ['key1'], removed: [], modified: [] }),
          },
          {
            version: 9,
            created_at: 1699999000,
            actor_id: 'system',
            actor_type: 'system',
            change_source: 'migration',
            change_reason: null,
            changes: JSON.stringify({ added: [], removed: ['old'], modified: [] }),
          },
        ],
      });

      const result = await manager.listVersions('oauth', { limit: 10, offset: 0 });

      expect(result.total).toBe(15);
      expect(result.versions.length).toBe(2);
      expect(result.versions[0].version).toBe(10);
      expect(result.versions[0].changesSummary.added).toBe(1);
    });
  });

  describe('getVersion', () => {
    it('should return a specific version', async () => {
      const mockStmt = mockDb.prepare();
      mockStmt.first.mockResolvedValueOnce({
        id: 'sh_abc123',
        tenant_id: 'test-tenant',
        category: 'oauth',
        version: 5,
        snapshot: JSON.stringify({ key1: 'value1' }),
        changes: JSON.stringify({ added: ['key1'], removed: [], modified: [] }),
        actor_id: 'admin-1',
        actor_type: 'admin',
        change_reason: 'Initial setup',
        change_source: 'admin_api',
        created_at: 1700000000,
      });

      const result = await manager.getVersion('oauth', 5);

      expect(result).not.toBeNull();
      expect(result!.version).toBe(5);
      expect(result!.snapshot).toEqual({ key1: 'value1' });
    });

    it('should return null for non-existent version', async () => {
      const mockStmt = mockDb.prepare();
      mockStmt.first.mockResolvedValueOnce(null);

      const result = await manager.getVersion('oauth', 999);

      expect(result).toBeNull();
    });
  });

  describe('getLatestVersion', () => {
    it('should return the latest version', async () => {
      const mockStmt = mockDb.prepare();
      // MAX version query
      mockStmt.first.mockResolvedValueOnce({ version: 10 });
      // getVersion query
      mockStmt.first.mockResolvedValueOnce({
        id: 'sh_latest',
        tenant_id: 'test-tenant',
        category: 'oauth',
        version: 10,
        snapshot: JSON.stringify({ latest: true }),
        changes: JSON.stringify({ added: [], removed: [], modified: [] }),
        actor_id: 'admin-1',
        actor_type: 'admin',
        change_reason: null,
        change_source: 'admin_api',
        created_at: 1700000000,
      });

      const result = await manager.getLatestVersion('oauth');

      expect(result).not.toBeNull();
      expect(result!.version).toBe(10);
    });

    it('should return null if no versions exist', async () => {
      const mockStmt = mockDb.prepare();
      mockStmt.first.mockResolvedValueOnce({ version: null });

      const result = await manager.getLatestVersion('oauth');

      expect(result).toBeNull();
    });
  });

  describe('rollback', () => {
    it('should rollback to target version and create new version', async () => {
      const mockStmt = mockDb.prepare();

      // 1. getVersion (target version 5)
      mockStmt.first.mockResolvedValueOnce({
        id: 'sh_v5',
        tenant_id: 'test-tenant',
        category: 'oauth',
        version: 5,
        snapshot: JSON.stringify({ oldConfig: 'value' }),
        changes: JSON.stringify({ added: [], removed: [], modified: [] }),
        actor_id: 'admin-1',
        actor_type: 'admin',
        change_reason: null,
        change_source: 'admin_api',
        created_at: 1700000000,
      });

      // 2. getLatestVersion - MAX query
      mockStmt.first.mockResolvedValueOnce({ version: 10 });

      // 3. getLatestVersion calls getVersion internally
      mockStmt.first.mockResolvedValueOnce({
        id: 'sh_v10',
        tenant_id: 'test-tenant',
        category: 'oauth',
        version: 10,
        snapshot: JSON.stringify({ currentConfig: 'latest' }),
        changes: JSON.stringify({ added: [], removed: [], modified: [] }),
        actor_id: 'admin-1',
        actor_type: 'admin',
        change_reason: null,
        change_source: 'admin_api',
        created_at: 1700001000,
      });

      // 4. recordChange - get last version for next version number
      mockStmt.first.mockResolvedValueOnce({ version: 10 });
      // 5. recordChange - insert
      mockStmt.run.mockResolvedValueOnce({ success: true });
      // 6-7. cleanup queries
      mockStmt.run.mockResolvedValueOnce({ success: true });
      mockStmt.run.mockResolvedValueOnce({ success: true });

      const getCurrentSnapshot = vi.fn().mockResolvedValue({ newConfig: 'current' });
      const applySnapshot = vi.fn().mockResolvedValue(undefined);

      const result = await manager.rollback(
        'oauth',
        {
          targetVersion: 5,
          actorId: 'admin-2',
          actorType: 'admin',
          changeReason: 'Rollback due to issue',
        },
        getCurrentSnapshot,
        applySnapshot
      );

      expect(result.success).toBe(true);
      expect(result.previousVersion).toBe(10);
      expect(result.currentVersion).toBe(11);
      expect(applySnapshot).toHaveBeenCalledWith({ oldConfig: 'value' });
    });

    it('should throw error if target version not found', async () => {
      const mockStmt = mockDb.prepare();
      mockStmt.first.mockResolvedValueOnce(null);

      await expect(
        manager.rollback(
          'oauth',
          { targetVersion: 999 },
          async () => ({}),
          async () => {}
        )
      ).rejects.toThrow('Version 999 not found');
    });
  });
});

describe('createSettingsHistoryManager', () => {
  it('should require a tenant', () => {
    const mockDb = createMockD1();
    expect(() =>
      createSettingsHistoryManager(mockDb as unknown as D1Database, '')
    ).toThrow('SettingsHistoryManager requires tenantId');
  });

  it('should create a manager with custom config', () => {
    const mockDb = createMockD1();
    const manager = createSettingsHistoryManager(mockDb as unknown as D1Database, 'my-tenant', {
      maxVersions: 50,
      retentionDays: 30,
    });

    expect(manager).toBeInstanceOf(SettingsHistoryManager);
  });
});
