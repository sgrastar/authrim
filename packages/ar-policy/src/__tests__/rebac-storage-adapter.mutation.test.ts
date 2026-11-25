import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { createPolicyReBACService, createReBACStorageAdapter } from '../rebac-storage-adapter';

function fakeDatabase(overrides: Partial<Record<'query' | 'execute', unknown>> = {}) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => [{ id: 'row-1' }]);
  const execute = vi.fn(async (_sql: string, _params?: unknown[]) => ({
    success: true,
    rowsAffected: 3,
    lastInsertRowid: 42,
  }));
  const adapter = { query, execute, ...overrides } as unknown as DatabaseAdapter;
  return { adapter, query, execute };
}

describe('createReBACStorageAdapter', () => {
  it('has no key-value storage of its own', async () => {
    const storage = createReBACStorageAdapter(fakeDatabase().adapter);

    expect(await storage.get('any-key')).toBeNull();
    expect(await storage.set('any-key', 'value', 30)).toBeUndefined();
    expect(await storage.delete('any-key')).toBeUndefined();
    // set does not make the value readable
    expect(await storage.get('any-key')).toBeNull();
  });

  it('forwards queries with their SQL and parameters', async () => {
    const { adapter, query } = fakeDatabase();
    const storage = createReBACStorageAdapter(adapter);

    await expect(storage.query('SELECT 1 WHERE a = ?', ['x'])).resolves.toEqual([{ id: 'row-1' }]);
    expect(query).toHaveBeenCalledWith('SELECT 1 WHERE a = ?', ['x']);
  });

  it('maps an execute result to the storage meta shape', async () => {
    const { adapter, execute } = fakeDatabase();
    const storage = createReBACStorageAdapter(adapter);

    await expect(storage.execute('DELETE FROM t WHERE a = ?', ['x'])).resolves.toEqual({
      success: true,
      meta: { changes: 3, last_row_id: 42 },
    });
    expect(execute).toHaveBeenCalledWith('DELETE FROM t WHERE a = ?', ['x']);
  });

  it('reports last_row_id 0 when the database gives no insert id', async () => {
    const { adapter } = fakeDatabase({
      execute: vi.fn(async () => ({ success: false, rowsAffected: 0 })),
    });
    const storage = createReBACStorageAdapter(adapter);

    await expect(storage.execute('UPDATE t SET a = 1')).resolves.toEqual({
      success: false,
      meta: { changes: 0, last_row_id: 0 },
    });
  });

  it('keeps an insert id of 0 as 0', async () => {
    const { adapter } = fakeDatabase({
      execute: vi.fn(async () => ({ success: true, rowsAffected: 1, lastInsertRowid: 0 })),
    });
    const storage = createReBACStorageAdapter(adapter);

    const result = await storage.execute('INSERT INTO t VALUES (1)');
    expect(result.meta.last_row_id).toBe(0);
  });
});

describe('createPolicyReBACService', () => {
  it('caches check results in the given namespace for 60 seconds', async () => {
    const { adapter } = fakeDatabase({ query: vi.fn(async () => []) });
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const service = createPolicyReBACService(adapter, kv);

    const result = await service.check({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      relation: 'viewer',
      object: 'document:doc-1',
    });

    expect(result.allowed).toBe(false);
    expect(kv.put).toHaveBeenCalled();
    const ttls = kv.put.mock.calls.map((call) => {
      const options = (call as unknown[])[2] as { expirationTtl: number };
      return options.expirationTtl;
    });
    expect(ttls).toContain(60);
  });

  it('works without a cache namespace', async () => {
    const query = vi.fn(async () => []);
    const { adapter } = fakeDatabase({ query });
    const service = createPolicyReBACService(adapter);

    const result = await service.check({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      relation: 'viewer',
      object: 'document:doc-1',
    });

    expect(result.allowed).toBe(false);
    expect(query).toHaveBeenCalled();
  });
});
