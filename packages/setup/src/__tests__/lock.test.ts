import { describe, expect, it } from 'vitest';
import {
  createLockFile,
  reconcileSharedD1ResourcesInLock,
  type AuthrimLock,
} from '../core/lock.js';

function createTestLock(): AuthrimLock {
  const lock = createLockFile('test', {
    d1: [
      { binding: 'DB', name: 'test-authrim-core-db', id: 'stale-core-id' },
      { binding: 'DB_PII', name: 'test-authrim-pii-db', id: 'stale-pii-id' },
      { binding: 'DB_ADMIN', name: 'test-authrim-admin-db', id: 'stale-admin-id' },
    ],
    kv: [],
    queues: [],
    r2: [],
  });
  lock.d1.TDB_CORE_0001 = {
    name: 'test-authrim-tenant-first-core-g1',
    id: 'tenant-core-id',
  };
  return lock;
}

describe('reconcileSharedD1ResourcesInLock', () => {
  it('refreshes stale and missing shared bindings while preserving tenant D1 entries', () => {
    const lock = createTestLock();
    lock.d1.DB.id = 'live-core-id';
    delete lock.d1.DB_ADMIN;

    const result = reconcileSharedD1ResourcesInLock(lock, 'test', [
      { name: 'test-authrim-core-db', uuid: 'live-core-id' },
      { name: 'test-authrim-pii-db', uuid: 'live-pii-id' },
      { name: 'test-authrim-admin-db', uuid: 'live-admin-id' },
    ]);

    expect(result.updatedBindings).toEqual(['DB_PII', 'DB_ADMIN']);
    expect(result.missingBindings).toEqual([]);
    expect(result.lock.d1.DB).toEqual({ name: 'test-authrim-core-db', id: 'live-core-id' });
    expect(result.lock.d1.DB_PII).toEqual({ name: 'test-authrim-pii-db', id: 'live-pii-id' });
    expect(result.lock.d1.DB_ADMIN).toEqual({
      name: 'test-authrim-admin-db',
      id: 'live-admin-id',
    });
    expect(result.lock.d1.TDB_CORE_0001).toEqual(lock.d1.TDB_CORE_0001);
  });

  it('reports a required shared database that does not exist by canonical name', () => {
    const lock = createTestLock();

    const result = reconcileSharedD1ResourcesInLock(lock, 'test', [
      { name: 'test-authrim-core-db', uuid: 'live-core-id' },
      { name: 'test-authrim-pii-db', uuid: 'live-pii-id' },
    ]);

    expect(result.missingBindings).toEqual([
      { binding: 'DB_ADMIN', name: 'test-authrim-admin-db' },
    ]);
    expect(result.lock.d1.DB_ADMIN).toEqual(lock.d1.DB_ADMIN);
  });

  it('returns the original lock when all shared IDs are current', () => {
    const lock = createTestLock();
    const databases = [
      { name: 'test-authrim-core-db', uuid: 'stale-core-id' },
      { name: 'test-authrim-pii-db', uuid: 'stale-pii-id' },
      { name: 'test-authrim-admin-db', uuid: 'stale-admin-id' },
    ];

    const result = reconcileSharedD1ResourcesInLock(lock, 'test', databases);

    expect(result.updatedBindings).toEqual([]);
    expect(result.missingBindings).toEqual([]);
    expect(result.lock).toBe(lock);
  });
});
