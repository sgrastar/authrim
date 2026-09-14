import { expect, it } from 'vitest';
import { resolveInstalledSqliteDatasets } from '../installed-sqlite-datasets';

const lease = {
  tenantId: 'tenant',
  operationId: 'operation',
  owner: 'worker',
  fencingToken: 1,
};
const capture = {
  table: 'roles',
  columns: ['id', 'tenant_id'],
  primaryKey: ['id'],
  uniqueKeys: [],
  tenantColumn: 'tenant_id',
};
const selected = (table: string, ordinal: number, resourceId = 'physical-core') => ({
  ordinal,
  item_id: `${resourceId}:${table}`,
  payload_digest: 'a'.repeat(64),
  chain_digest: 'b'.repeat(64),
  payload_json: JSON.stringify({
    version: 1,
    resourceId,
    family: 'core',
    table,
    kind: 'settings',
    selection: { action: 'selected' },
    capture: { ...capture, table },
    schemaDigest: 'c'.repeat(64),
  }),
});
const skipped = (table: string, ordinal: number) => ({
  ...selected(table, ordinal),
  payload_json: JSON.stringify({
    version: 1,
    resourceId: 'physical-core',
    family: 'core',
    table,
    kind: 'users',
    selection: { action: 'excluded' },
    capture: null,
    schemaDigest: 'd'.repeat(64),
  }),
});
const descriptor = {
  ordinal: 0,
  item_id: 'database:physical-core',
  payload_json: '{}',
  payload_digest: 'e'.repeat(64),
  chain_digest: 'f'.repeat(64),
};
const registration = (table: string) => ({
  family: 'core' as const,
  table,
  dataset: {
    id: `core.${table}`,
    module: 'authorization' as const,
    kind: 'settings' as const,
    store: 'database' as const,
    schemaVersion: 1,
    disposition: 'include' as const,
  },
});

function inventory(items: ReturnType<typeof selected>[]) {
  return {
    async headForLease() {
      return { state: 'sealed' as const, item_count: items.length };
    },
    async readPage(from: number) {
      return items.slice(from, from + 16);
    },
  };
}

it('resolves all selected tables and retains the physical resource first ordinal', async () => {
  const result = await resolveInstalledSqliteDatasets({
    inventory: inventory([descriptor as never, skipped('users', 1), selected('roles', 2)]),
    lease,
    registrations: [registration('roles')],
  });
  expect(result).toEqual([
    expect.objectContaining({
      ordinal: 2,
      firstOrdinal: 1,
      resourceId: 'physical-core',
      table: 'roles',
      dataset: expect.objectContaining({ id: 'core.roles' }),
    }),
  ]);
});

it('fails the complete plan for a selected table missing an installed adapter', async () => {
  await expect(
    resolveInstalledSqliteDatasets({
      inventory: inventory([selected('roles', 0), selected('oauth_clients', 1)]),
      lease,
      registrations: [registration('roles')],
    })
  ).rejects.toThrow('backup_installed_sqlite_dataset_invalid');
});

it('rejects duplicate dataset identities and malformed capture metadata', async () => {
  await expect(
    resolveInstalledSqliteDatasets({
      inventory: inventory([selected('roles', 0)]),
      lease,
      registrations: [
        registration('roles'),
        { ...registration('oauth_clients'), dataset: registration('roles').dataset },
      ],
    })
  ).rejects.toThrow('backup_installed_sqlite_dataset_invalid');
  const malformed = selected('roles', 0);
  malformed.payload_json = JSON.stringify({
    ...JSON.parse(malformed.payload_json),
    capture: { ...capture, primaryKey: [] },
  });
  await expect(
    resolveInstalledSqliteDatasets({
      inventory: inventory([malformed]),
      lease,
      registrations: [registration('roles')],
    })
  ).rejects.toThrow('backup_installed_sqlite_dataset_invalid');
});

it('resolves disjoint selected row partitions and rejects incomplete installed coverage', async () => {
  const partitioned = selected('resource_permissions', 0);
  partitioned.payload_json = JSON.stringify({
    ...JSON.parse(partitioned.payload_json),
    capture: {
      ...capture,
      table: 'resource_permissions',
      columns: ['id', 'tenant_id', 'subject_type'],
      rowPartition: { column: 'subject_type', values: ['user', 'role', 'org'] },
    },
    rowPartitions: [
      { value: 'user', kind: 'users', selection: { action: 'excluded', reason: 'not_selected' } },
      { value: 'role', kind: 'settings', selection: { action: 'selected', timeFilter: 'none' } },
      { value: 'org', kind: 'settings', selection: { action: 'selected', timeFilter: 'none' } },
    ],
  });
  const settings = {
    ...registration('resource_permissions'),
    dataset: {
      ...registration('resource_permissions').dataset,
      id: 'core.resource_permissions.settings',
    },
    partitions: ['role', 'org'],
  };
  const result = await resolveInstalledSqliteDatasets({
    inventory: inventory([partitioned]),
    lease,
    registrations: [settings],
  });
  expect(result).toEqual([
    expect.objectContaining({
      table: 'resource_permissions',
      partitions: ['role', 'org'],
      dataset: expect.objectContaining({ id: 'core.resource_permissions.settings' }),
    }),
  ]);

  await expect(
    resolveInstalledSqliteDatasets({
      inventory: inventory([partitioned]),
      lease,
      registrations: [{ ...settings, partitions: ['role'] }],
    })
  ).rejects.toThrow('backup_installed_sqlite_dataset_invalid');
  await expect(
    resolveInstalledSqliteDatasets({
      inventory: inventory([partitioned]),
      lease,
      registrations: [
        settings,
        {
          ...settings,
          dataset: { ...settings.dataset, id: 'core.resource_permissions.overlap' },
          partitions: ['org'],
        },
      ],
    })
  ).rejects.toThrow('backup_installed_sqlite_dataset_invalid');
});
