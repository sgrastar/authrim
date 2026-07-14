import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { D1StatusListRepository } from '../vc/status-list';

function adapter(queryResult: unknown = null) {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(queryResult),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
  } as unknown as DatabaseAdapter;
}

describe('D1StatusListRepository allocation safety', () => {
  it('allocates an index with one tenant-scoped, active, capacity-checked statement', async () => {
    const db = adapter({ used_count: 17 });
    const repository = new D1StatusListRepository(db);

    await expect(repository.incrementUsedCount('tenant-a', 'list-1')).resolves.toBe(17);

    expect(db.execute).not.toHaveBeenCalled();
    expect(db.queryOne).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE status_lists[\s\S]*tenant_id = \?[\s\S]*state = 'active'[\s\S]*used_count < capacity[\s\S]*RETURNING used_count/
      ),
      [expect.any(String), 'tenant-a', 'list-1']
    );
  });

  it('fails allocation when the list is missing, sealed, or full', async () => {
    const db = adapter(null);
    const repository = new D1StatusListRepository(db);

    await expect(repository.incrementUsedCount('tenant-a', 'list-1')).rejects.toThrow(
      'Status list not found, inactive, or full: list-1'
    );
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not archive recent lists for invalid retention %s',
    async (olderThanDays) => {
      const db = adapter();
      const repository = new D1StatusListRepository(db);

      await expect(repository.archiveSealedLists('tenant-a', olderThanDays)).resolves.toBe(0);
      expect(db.execute).not.toHaveBeenCalled();
    }
  );

  it('keeps list lookup and state updates tenant-scoped', async () => {
    const db = adapter(null);
    const repository = new D1StatusListRepository(db);

    await repository.findById('tenant-a', 'list-1');
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), [
      'tenant-a',
      'list-1',
    ]);

    await repository.update('tenant-a', 'list-1', { state: 'sealed', sealed_at: '2026-01-01' });
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = ? AND public_id = ?'),
      [expect.any(String), 'sealed', '2026-01-01', 'tenant-a', 'list-1']
    );
  });
});
