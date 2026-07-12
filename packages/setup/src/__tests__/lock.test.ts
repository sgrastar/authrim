import { describe, expect, it } from 'vitest';
import {
  createLockFile,
  reconcileSharedD1ResourcesInLock,
  reconcileSharedKVResourcesInLock,
  type AuthrimLock,
} from '../core/lock.js';
import { KV_NAMESPACES, getKVNamespaceName } from '../core/naming.js';

function createTestLock(): AuthrimLock {
  const lock = createLockFile('test', {
    d1: [
      { binding: 'DB', name: 'test-authrim-core-db', id: 'stale-core-id' },
      { binding: 'DB_PII', name: 'test-authrim-pii-db', id: 'stale-pii-id' },
      { binding: 'DB_ADMIN', name: 'test-authrim-admin-db', id: 'stale-admin-id' },
    ],
    kv: KV_NAMESPACES.map((binding) => ({
      binding,
      name: getKVNamespaceName('test', binding),
      id: `live-${binding.toLowerCase()}`,
    })),
    queues: [],
    r2: [],
  });
  lock.d1.TDB_SLOT_0001_CORE = {
    name: 'authrim-test-tdb-slot-0001-core',
    id: 'stale-tenant-core-id',
  };
  return lock;
}

describe('reconcileSharedD1ResourcesInLock', () => {
  it('refreshes stale and missing shared bindings and stale tenant D1 entries', () => {
    const lock = createTestLock();
    lock.d1.DB.id = 'live-core-id';
    delete lock.d1.DB_ADMIN;

    const result = reconcileSharedD1ResourcesInLock(lock, 'test', [
      { name: 'test-authrim-core-db', uuid: 'live-core-id' },
      { name: 'test-authrim-pii-db', uuid: 'live-pii-id' },
      { name: 'test-authrim-admin-db', uuid: 'live-admin-id' },
      { name: 'authrim-test-tdb-slot-0001-core', uuid: 'live-tenant-core-id' },
    ]);

    expect(result.updatedBindings).toEqual(['DB_PII', 'DB_ADMIN', 'TDB_SLOT_0001_CORE']);
    expect(result.missingBindings).toEqual([]);
    expect(result.lock.d1.DB).toEqual({ name: 'test-authrim-core-db', id: 'live-core-id' });
    expect(result.lock.d1.DB_PII).toEqual({ name: 'test-authrim-pii-db', id: 'live-pii-id' });
    expect(result.lock.d1.DB_ADMIN).toEqual({
      name: 'test-authrim-admin-db',
      id: 'live-admin-id',
    });
    expect(result.lock.d1.TDB_SLOT_0001_CORE).toEqual({
      name: 'authrim-test-tdb-slot-0001-core',
      id: 'live-tenant-core-id',
    });
  });

  it('reports a required shared database that does not exist by canonical name', () => {
    const lock = createTestLock();

    const result = reconcileSharedD1ResourcesInLock(lock, 'test', [
      { name: 'test-authrim-core-db', uuid: 'live-core-id' },
      { name: 'test-authrim-pii-db', uuid: 'live-pii-id' },
      { name: 'authrim-test-tdb-slot-0001-core', uuid: 'stale-tenant-core-id' },
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
      { name: 'authrim-test-tdb-slot-0001-core', uuid: 'stale-tenant-core-id' },
    ];

    const result = reconcileSharedD1ResourcesInLock(lock, 'test', databases);

    expect(result.updatedBindings).toEqual([]);
    expect(result.missingBindings).toEqual([]);
    expect(result.lock).toBe(lock);
  });

  it('reports a generated tenant database that no longer exists', () => {
    const lock = createTestLock();

    const result = reconcileSharedD1ResourcesInLock(lock, 'test', [
      { name: 'test-authrim-core-db', uuid: 'stale-core-id' },
      { name: 'test-authrim-pii-db', uuid: 'stale-pii-id' },
      { name: 'test-authrim-admin-db', uuid: 'stale-admin-id' },
    ]);

    expect(result.missingBindings).toEqual([
      { binding: 'TDB_SLOT_0001_CORE', name: 'authrim-test-tdb-slot-0001-core' },
    ]);
  });
});

function createLiveKVNamespaces() {
  return KV_NAMESPACES.map((binding) => ({
    title: getKVNamespaceName('test', binding),
    id: `live-${binding.toLowerCase()}`,
  }));
}

describe('reconcileSharedKVResourcesInLock', () => {
  it('refreshes stale and missing canonical KV bindings', () => {
    const lock = createTestLock();
    lock.kv.AUTHRIM_CONFIG.id = 'stale-config-id';
    delete lock.kv.SETTINGS;

    const result = reconcileSharedKVResourcesInLock(lock, 'test', createLiveKVNamespaces());

    expect(result.updatedBindings).toEqual(['SETTINGS', 'AUTHRIM_CONFIG']);
    expect(result.missingBindings).toEqual([]);
    expect(result.lock.kv.SETTINGS).toEqual({
      name: 'TEST-SETTINGS',
      id: 'live-settings',
    });
    expect(result.lock.kv.AUTHRIM_CONFIG).toEqual({
      name: 'TEST-AUTHRIM_CONFIG',
      id: 'live-authrim_config',
    });
  });

  it('reports a required canonical KV namespace that is missing', () => {
    const lock = createTestLock();
    const namespaces = createLiveKVNamespaces().filter(
      (namespace) => namespace.title !== 'TEST-AUTHRIM_CONFIG'
    );

    const result = reconcileSharedKVResourcesInLock(lock, 'test', namespaces);

    expect(result.missingBindings).toEqual([
      { binding: 'AUTHRIM_CONFIG', name: 'TEST-AUTHRIM_CONFIG' },
    ]);
    expect(result.lock.kv.AUTHRIM_CONFIG).toEqual(lock.kv.AUTHRIM_CONFIG);
  });

  it('returns the original lock when all canonical KV IDs are current', () => {
    const lock = createTestLock();

    const result = reconcileSharedKVResourcesInLock(lock, 'test', createLiveKVNamespaces());

    expect(result.updatedBindings).toEqual([]);
    expect(result.missingBindings).toEqual([]);
    expect(result.lock).toBe(lock);
  });
});
