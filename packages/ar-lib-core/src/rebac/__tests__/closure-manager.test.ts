import { describe, expect, it, vi } from 'vitest';
import type { IStorageAdapter } from '../../storage/interfaces';
import { ClosureManager } from '../closure-manager';

function adapterWithRows(rows: unknown[] = []) {
  return {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    query: vi.fn().mockResolvedValue(rows),
    execute: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as IStorageAdapter;
}

describe('ClosureManager tenant and graph boundaries', () => {
  it('paginates objects while keeping every lookup tenant-scoped', async () => {
    const adapter = adapterWithRows([
      { descendant_id: 'doc-1' },
      { descendant_id: 'doc-2' },
      { descendant_id: 'doc-3' },
    ]);
    const manager = new ClosureManager(adapter);

    await expect(
      manager.getObjectsForUser('tenant-a', 'user-1', 'viewer', 'document', {
        limit: 2,
        cursor: '4',
      })
    ).resolves.toEqual({ objectIds: ['doc-1', 'doc-2'], nextCursor: '6' });
    expect(adapter.query).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), [
      'tenant-a',
      'user-1',
      'document',
      'viewer',
      3,
      4,
    ]);
  });

  it('recomputes by deleting stale entries before inserting tenant-scoped paths', async () => {
    const adapter = adapterWithRows([
      {
        user_id: 'user-1',
        relation: 'viewer',
        depth: 2,
        path: 'rel-1,rel-2',
        permission: 'read_only',
      },
    ]);
    const manager = new ClosureManager(adapter, 4);

    await manager.recomputeForObject('tenant-a', 'document', 'doc-1');

    expect(adapter.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('DELETE FROM relationship_closure'),
      ['tenant-a', 'document', 'doc-1']
    );
    expect(adapter.query).toHaveBeenCalledWith(expect.stringContaining('WITH RECURSIVE'), [
      'tenant-a',
      'document',
      'doc-1',
      expect.any(Number),
      'tenant-a',
      4,
      expect.any(Number),
    ]);
    expect(adapter.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO relationship_closure'),
      expect.arrayContaining(['tenant-a', 'user-1', 'document', 'doc-1', '["rel-1","rel-2"]'])
    );
  });

  it('processes mixed user/object recomputation in configured batches', async () => {
    const manager = new ClosureManager(adapterWithRows(), 5, 2);
    const user = vi.spyOn(manager, 'recomputeForUser').mockResolvedValue(undefined);
    const object = vi.spyOn(manager, 'recomputeForObject').mockResolvedValue(undefined);

    await manager.batchRecompute('tenant-a', [
      { type: 'user', entityType: 'subject', entityId: 'user-1' },
      { type: 'object', entityType: 'document', entityId: 'doc-1' },
      { type: 'user', entityType: 'subject', entityId: 'user-2' },
    ]);

    expect(user).toHaveBeenCalledTimes(2);
    expect(object).toHaveBeenCalledWith('tenant-a', 'document', 'doc-1');
  });

  it('maps malformed optional paths as an explicit data integrity error', async () => {
    const manager = new ClosureManager(
      adapterWithRows([
        {
          id: 'closure-1',
          tenant_id: 'tenant-a',
          ancestor_type: 'subject',
          ancestor_id: 'user-1',
          descendant_type: 'document',
          descendant_id: 'doc-1',
          relation: 'viewer',
          depth: 1,
          path_json: '{',
          effective_permission: null,
          created_at: 1,
          updated_at: 1,
        },
      ])
    );

    await expect(manager.getClosureEntries('tenant-a')).rejects.toThrow();
  });
});
