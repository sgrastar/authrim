/**
 * Status List Manager Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StatusListManager,
  StatusListRepository,
  StatusListRecord,
  StatusListPurpose,
  StatusListState,
  StatusValue,
} from '../status-list-manager';

// Mock repository implementation
class MockStatusListRepository implements StatusListRepository {
  private lists = new Map<string, StatusListRecord>();

  async findActiveList(
    tenantId: string,
    purpose: StatusListPurpose
  ): Promise<StatusListRecord | null> {
    for (const list of this.lists.values()) {
      if (list.tenant_id === tenantId && list.purpose === purpose && list.state === 'active') {
        return list;
      }
    }
    return null;
  }

  async findById(listId: string): Promise<StatusListRecord | null> {
    return this.lists.get(listId) || null;
  }

  async create(record: Omit<StatusListRecord, 'created_at' | 'updated_at'>): Promise<void> {
    const now = new Date().toISOString();
    this.lists.set(record.id, {
      ...record,
      created_at: now,
      updated_at: now,
    });
  }

  async update(
    listId: string,
    updates: Partial<Pick<StatusListRecord, 'encoded_list' | 'used_count' | 'state' | 'sealed_at'>>
  ): Promise<void> {
    const list = this.lists.get(listId);
    if (!list) throw new Error('List not found');
    this.lists.set(listId, {
      ...list,
      ...updates,
      updated_at: new Date().toISOString(),
    });
  }

  async incrementUsedCount(listId: string): Promise<number> {
    const list = this.lists.get(listId);
    if (!list) throw new Error('List not found');
    const newCount = list.used_count + 1;
    list.used_count = newCount;
    list.updated_at = new Date().toISOString();
    return newCount;
  }

  async listByTenant(
    tenantId: string,
    options?: { purpose?: StatusListPurpose; state?: StatusListState }
  ): Promise<StatusListRecord[]> {
    const result: StatusListRecord[] = [];
    for (const list of this.lists.values()) {
      if (list.tenant_id !== tenantId) continue;
      if (options?.purpose && list.purpose !== options.purpose) continue;
      if (options?.state && list.state !== options.state) continue;
      result.push(list);
    }
    return result;
  }

  // Helper for tests
  clear(): void {
    this.lists.clear();
  }

  getAll(): StatusListRecord[] {
    return Array.from(this.lists.values());
  }
}

describe('StatusListManager', () => {
  let repository: MockStatusListRepository;
  let manager: StatusListManager;

  beforeEach(() => {
    repository = new MockStatusListRepository();
    manager = new StatusListManager(repository);
  });

  describe('createStatusList', () => {
    it('should create a new status list with default capacity', async () => {
      const list = await manager.createStatusList('tenant1', 'revocation');

      expect(list.id).toMatch(/^sl_r_tenant1_/);
      expect(list.tenant_id).toBe('tenant1');
      expect(list.purpose).toBe('revocation');
      expect(list.capacity).toBe(131072);
      expect(list.used_count).toBe(0);
      expect(list.state).toBe('active');
      expect(list.sealed_at).toBeNull();
    });

    it('should create a status list with custom capacity', async () => {
      const list = await manager.createStatusList('tenant1', 'suspension', 1000);

      expect(list.capacity).toBe(1000);
      expect(list.purpose).toBe('suspension');
    });

    it('should create encoded bitstring', async () => {
      const list = await manager.createStatusList('tenant1', 'revocation');

      expect(list.encoded_list).toBeTruthy();
      // Should be base64url encoded
      expect(list.encoded_list).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('allocateIndex', () => {
    it('should create a new list if none exists', async () => {
      const allocation = await manager.allocateIndex('tenant1', 'revocation');

      expect(allocation.listId).toMatch(/^sl_r_tenant1_/);
      expect(allocation.index).toBe(0);
    });

    it('should allocate sequential indices', async () => {
      const alloc1 = await manager.allocateIndex('tenant1', 'revocation');
      const alloc2 = await manager.allocateIndex('tenant1', 'revocation');
      const alloc3 = await manager.allocateIndex('tenant1', 'revocation');

      expect(alloc1.index).toBe(0);
      expect(alloc2.index).toBe(1);
      expect(alloc3.index).toBe(2);
      expect(alloc1.listId).toBe(alloc2.listId);
      expect(alloc2.listId).toBe(alloc3.listId);
    });

    it('should rotate to a new list when capacity is reached', async () => {
      // Create a list with small capacity for testing
      const smallList = await manager.createStatusList('tenant1', 'revocation', 3);

      // Fill up the list
      const alloc1 = await manager.allocateIndex('tenant1', 'revocation');
      const alloc2 = await manager.allocateIndex('tenant1', 'revocation');
      const alloc3 = await manager.allocateIndex('tenant1', 'revocation');

      // This should trigger rotation
      const alloc4 = await manager.allocateIndex('tenant1', 'revocation');

      expect(alloc1.listId).toBe(smallList.id);
      expect(alloc2.listId).toBe(smallList.id);
      expect(alloc3.listId).toBe(smallList.id);
      expect(alloc4.listId).not.toBe(smallList.id);
      expect(alloc4.index).toBe(0); // New list starts at 0

      // Check old list is sealed
      const oldList = await manager.getStatusList(smallList.id);
      expect(oldList?.state).toBe('sealed');
      expect(oldList?.sealed_at).toBeTruthy();
    });

    it('should separate lists by purpose', async () => {
      const revAlloc = await manager.allocateIndex('tenant1', 'revocation');
      const susAlloc = await manager.allocateIndex('tenant1', 'suspension');

      expect(revAlloc.listId).not.toBe(susAlloc.listId);
    });

    it('should separate lists by tenant', async () => {
      const tenant1Alloc = await manager.allocateIndex('tenant1', 'revocation');
      const tenant2Alloc = await manager.allocateIndex('tenant2', 'revocation');

      expect(tenant1Alloc.listId).not.toBe(tenant2Alloc.listId);
    });
  });

  describe('updateStatus', () => {
    it('should revoke a credential', async () => {
      const { listId, index } = await manager.allocateIndex('tenant1', 'revocation');

      // Initially valid
      expect(await manager.getStatus(listId, index)).toBe(StatusValue.VALID);

      // Revoke
      await manager.revoke(listId, index);

      // Now invalid
      expect(await manager.getStatus(listId, index)).toBe(StatusValue.INVALID);
    });

    it('should suspend a credential', async () => {
      const { listId, index } = await manager.allocateIndex('tenant1', 'suspension');

      await manager.suspend(listId, index);

      expect(await manager.getStatus(listId, index)).toBe(StatusValue.INVALID);
    });

    it('should activate a suspended credential', async () => {
      const { listId, index } = await manager.allocateIndex('tenant1', 'suspension');

      await manager.suspend(listId, index);
      expect(await manager.getStatus(listId, index)).toBe(StatusValue.INVALID);

      await manager.activate(listId, index);
      expect(await manager.getStatus(listId, index)).toBe(StatusValue.VALID);
    });

    it('should handle multiple status updates', async () => {
      const alloc1 = await manager.allocateIndex('tenant1', 'revocation');
      const alloc2 = await manager.allocateIndex('tenant1', 'revocation');
      const alloc3 = await manager.allocateIndex('tenant1', 'revocation');

      // Revoke first and third
      await manager.revoke(alloc1.listId, alloc1.index);
      await manager.revoke(alloc3.listId, alloc3.index);

      expect(await manager.getStatus(alloc1.listId, alloc1.index)).toBe(StatusValue.INVALID);
      expect(await manager.getStatus(alloc2.listId, alloc2.index)).toBe(StatusValue.VALID);
      expect(await manager.getStatus(alloc3.listId, alloc3.index)).toBe(StatusValue.INVALID);
    });

    it('should throw error for non-existent list', async () => {
      await expect(manager.updateStatus('non-existent', 0, StatusValue.INVALID)).rejects.toThrow(
        'Status list not found: non-existent'
      );
    });
  });

  describe('getEncodedList', () => {
    it('should return encoded bitstring', async () => {
      const list = await manager.createStatusList('tenant1', 'revocation');
      const encoded = await manager.getEncodedList(list.id);

      expect(encoded).toBe(list.encoded_list);
    });

    it('should throw error for non-existent list', async () => {
      await expect(manager.getEncodedList('non-existent')).rejects.toThrow(
        'Status list not found: non-existent'
      );
    });
  });

  describe('listStatusLists', () => {
    it('should list all status lists for a tenant', async () => {
      await manager.createStatusList('tenant1', 'revocation');
      await manager.createStatusList('tenant1', 'suspension');
      await manager.createStatusList('tenant2', 'revocation');

      const lists = await manager.listStatusLists('tenant1');

      expect(lists).toHaveLength(2);
      expect(lists.every((l) => l.tenant_id === 'tenant1')).toBe(true);
    });

    it('should filter by purpose', async () => {
      await manager.createStatusList('tenant1', 'revocation');
      await manager.createStatusList('tenant1', 'suspension');

      const lists = await manager.listStatusLists('tenant1', { purpose: 'revocation' });

      expect(lists).toHaveLength(1);
      expect(lists[0].purpose).toBe('revocation');
    });

    it('should filter by state', async () => {
      // Create and fill a list to seal it
      const list = await manager.createStatusList('tenant1', 'revocation', 1);
      await manager.allocateIndex('tenant1', 'revocation');
      await manager.allocateIndex('tenant1', 'revocation'); // This triggers rotation

      const activeLists = await manager.listStatusLists('tenant1', { state: 'active' });
      const sealedLists = await manager.listStatusLists('tenant1', { state: 'sealed' });

      expect(activeLists).toHaveLength(1);
      expect(sealedLists).toHaveLength(1);
      expect(activeLists[0].id).not.toBe(list.id);
      expect(sealedLists[0].id).toBe(list.id);
    });
  });

  describe('calculateETag', () => {
    it('should generate consistent ETag', async () => {
      const list = await manager.createStatusList('tenant1', 'revocation');

      const etag1 = await manager.calculateETag(list.id);
      const etag2 = await manager.calculateETag(list.id);

      expect(etag1).toBe(etag2);
      expect(etag1).toMatch(/^"[a-f0-9]{16}"$/);
    });

    it('should change ETag after status update', async () => {
      const { listId, index } = await manager.allocateIndex('tenant1', 'revocation');

      const etagBefore = await manager.calculateETag(listId);
      await manager.revoke(listId, index);
      const etagAfter = await manager.calculateETag(listId);

      expect(etagBefore).not.toBe(etagAfter);
    });

    it('should throw error for non-existent list', async () => {
      await expect(manager.calculateETag('non-existent')).rejects.toThrow(
        'Status list not found: non-existent'
      );
    });
  });

  describe('edge cases', () => {
    it('should handle large index values', async () => {
      // Create a list and manually set used_count to simulate many allocations
      const list = await manager.createStatusList('tenant1', 'revocation');

      // Update status at a high index
      await manager.updateStatus(list.id, 1000, StatusValue.INVALID);
      expect(await manager.getStatus(list.id, 1000)).toBe(StatusValue.INVALID);
      expect(await manager.getStatus(list.id, 999)).toBe(StatusValue.VALID);
      expect(await manager.getStatus(list.id, 1001)).toBe(StatusValue.VALID);
    });

    it('should handle boundary index values', async () => {
      const list = await manager.createStatusList('tenant1', 'revocation', 16); // 16 bits = 2 bytes

      // Test first bit
      await manager.updateStatus(list.id, 0, StatusValue.INVALID);
      expect(await manager.getStatus(list.id, 0)).toBe(StatusValue.INVALID);

      // Test last bit
      await manager.updateStatus(list.id, 15, StatusValue.INVALID);
      expect(await manager.getStatus(list.id, 15)).toBe(StatusValue.INVALID);

      // Middle bits should still be valid
      expect(await manager.getStatus(list.id, 7)).toBe(StatusValue.VALID);
      expect(await manager.getStatus(list.id, 8)).toBe(StatusValue.VALID);
    });

    it('should correctly handle byte boundaries', async () => {
      const list = await manager.createStatusList('tenant1', 'revocation', 24); // 3 bytes

      // Set bits at byte boundaries
      await manager.updateStatus(list.id, 7, StatusValue.INVALID); // Last bit of first byte
      await manager.updateStatus(list.id, 8, StatusValue.INVALID); // First bit of second byte
      await manager.updateStatus(list.id, 15, StatusValue.INVALID); // Last bit of second byte
      await manager.updateStatus(list.id, 16, StatusValue.INVALID); // First bit of third byte

      expect(await manager.getStatus(list.id, 6)).toBe(StatusValue.VALID);
      expect(await manager.getStatus(list.id, 7)).toBe(StatusValue.INVALID);
      expect(await manager.getStatus(list.id, 8)).toBe(StatusValue.INVALID);
      expect(await manager.getStatus(list.id, 9)).toBe(StatusValue.VALID);
      expect(await manager.getStatus(list.id, 14)).toBe(StatusValue.VALID);
      expect(await manager.getStatus(list.id, 15)).toBe(StatusValue.INVALID);
      expect(await manager.getStatus(list.id, 16)).toBe(StatusValue.INVALID);
      expect(await manager.getStatus(list.id, 17)).toBe(StatusValue.VALID);
    });
  });
});
