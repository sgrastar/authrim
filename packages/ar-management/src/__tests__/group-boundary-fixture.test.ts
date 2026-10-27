import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createD1Adapter, withGroupInputWrite } from '@authrim/ar-lib-core';
import { installGroupBoundaryFixture } from './helpers/group-boundary-fixture';

describe('management D1 group boundary fixture', () => {
  let binding: D1Database;
  let database: ReturnType<typeof installGroupBoundaryFixture>;
  let delegated: D1PreparedStatement;
  beforeEach(() => {
    delegated = {} as D1PreparedStatement;
    binding = { prepare: vi.fn(() => delegated) } as unknown as D1Database;
    database = installGroupBoundaryFixture(binding);
  });
  afterEach(() => database.close());

  const boundaries = () =>
    database.prepare('SELECT tenant_id,user_id,status FROM service_group_write_boundaries').all();
  const revisions = () =>
    database.prepare('SELECT tenant_id,user_id,revision FROM service_group_inputs').all();

  it('reports trigger-inclusive counts, preserves zero matches, and delegates unrelated SQL', async () => {
    const result = await binding
      .prepare(
        "INSERT INTO service_group_write_boundaries(id,tenant_id,user_id,operation,status,created_at) VALUES (?,?,?,?,'writing',?)"
      )
      .bind('boundary', 'tenant-a', 'user', 'test', 1)
      .run();
    expect(result.meta.changes).toBe(2);
    const wrongTenant = await binding
      .prepare('DELETE FROM service_group_write_boundaries WHERE tenant_id=? AND id=?')
      .bind('tenant-b', 'boundary')
      .run();
    expect(wrongTenant.meta.changes).toBe(0);
    expect(boundaries()).toEqual([{ tenant_id: 'tenant-a', user_id: 'user', status: 'writing' }]);
    expect(revisions()).toEqual([{ tenant_id: 'tenant-a', user_id: 'user', revision: 1 }]);
    expect(binding.prepare('UPDATE identity_accounts SET updated_at=1')).toBe(delegated);
  });

  it('executes the shared write and advances the revision again when its boundary is removed', async () => {
    const write = vi.fn(async () => 'done');
    await expect(
      withGroupInputWrite(createD1Adapter(binding), 'tenant-a', 'user', 'test', write)
    ).resolves.toBe('done');
    expect(write).toHaveBeenCalledOnce();
    expect(boundaries()).toEqual([]);
    expect(revisions()).toEqual([{ tenant_id: 'tenant-a', user_id: 'user', revision: 2 }]);
  });

  it('retains the failed fence and propagates the original write failure', async () => {
    await expect(
      withGroupInputWrite(createD1Adapter(binding), 'tenant-a', 'user', 'test', async () => {
        throw new Error('injected PII failure');
      })
    ).rejects.toThrow('injected PII failure');
    expect(boundaries()).toEqual([{ tenant_id: 'tenant-a', user_id: 'user', status: 'failed' }]);
    expect(revisions()).toEqual([{ tenant_id: 'tenant-a', user_id: 'user', revision: 1 }]);
  });

  it('never starts the protected write when SQLite ignored the boundary INSERT', async () => {
    database.exec(
      'CREATE TRIGGER reject_boundary BEFORE INSERT ON service_group_write_boundaries BEGIN SELECT RAISE(IGNORE); END'
    );
    const write = vi.fn(async () => 'must not run');
    await expect(
      withGroupInputWrite(createD1Adapter(binding), 'tenant-a', 'user', 'test', write)
    ).rejects.toThrow('group_boundary_write_failed');
    expect(write).not.toHaveBeenCalled();
    expect(boundaries()).toEqual([]);
    expect(revisions()).toEqual([]);
  });
});
