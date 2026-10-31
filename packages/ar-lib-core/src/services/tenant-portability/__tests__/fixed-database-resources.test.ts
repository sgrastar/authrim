import { expect, it, vi } from 'vitest';
import { resolveFixedBackupDatabaseResources } from '../fixed-database-resources';
const binding = () => ({ prepare: vi.fn(), batch: vi.fn() });
it('resolves fixed databases from generated metadata without probing or fallback', () => {
  const db = binding(),
    admin = binding();
  const env = {
    DB: db,
    DB_ADMIN: admin,
    AUTHRIM_FIXED_DATABASE_IDS: JSON.stringify({
      version: 1,
      databases: { DB: 'core-id', DB_ADMIN: 'admin-id' },
    }),
  };
  expect(
    resolveFixedBackupDatabaseResources(env, ['DB_ADMIN', 'DB']).map((resource) => [
      resource.binding,
      resource.family,
      resource.databaseId,
    ])
  ).toEqual([
    ['DB', 'core', 'core-id'],
    ['DB_ADMIN', 'admin', 'admin-id'],
  ]);
  expect(db.prepare).not.toHaveBeenCalled();
  expect(admin.prepare).not.toHaveBeenCalled();
  expect(() => resolveFixedBackupDatabaseResources(env, ['CONTROL_DB'])).toThrow('binding_missing');
});
it('rejects absent metadata, bindings, duplicate roles and unknown resource claims', () => {
  expect(() => resolveFixedBackupDatabaseResources({}, ['DB_ADMIN'])).toThrow('metadata_missing');
  expect(() =>
    resolveFixedBackupDatabaseResources(
      { AUTHRIM_FIXED_DATABASE_IDS: '{"version":1,"databases":{"DB_ADMIN":"admin-id"}}' },
      ['DB_ADMIN']
    )
  ).toThrow('binding_missing');
  expect(() => resolveFixedBackupDatabaseResources({}, ['DB_ADMIN', 'DB_ADMIN'])).toThrow(
    'invalid_request'
  );
  expect(() =>
    resolveFixedBackupDatabaseResources(
      { AUTHRIM_FIXED_DATABASE_IDS: '{"version":1,"databases":{"TDB_FOREIGN":"id"}}' },
      ['DB_ADMIN']
    )
  ).toThrow('metadata_invalid');
});
it('does not treat shared provider IDs as distinct fixed databases', () => {
  const env = {
    DB: binding(),
    DB_ADMIN: binding(),
    AUTHRIM_FIXED_DATABASE_IDS: JSON.stringify({
      version: 1,
      databases: { DB: 'same', DB_ADMIN: 'same' },
    }),
  };
  expect(() => resolveFixedBackupDatabaseResources(env, ['DB', 'DB_ADMIN'])).toThrow(
    'role_conflict'
  );
});
