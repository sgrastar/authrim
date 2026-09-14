import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { MIGRATION_STREAM_CONTRACTS } from '../../control-plane/migration-stream-contract';
import { TENANT_DATASET_POLICIES } from '../dataset-registry';
import {
  PHASE3_SQLITE_DATASET_REGISTRATIONS,
  PHASE3_SQLITE_TABLE_GROUPS,
} from '../phase3-sqlite-modules';
import { planSqliteTenantDatasets } from '../sqlite-dataset-plan';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const inventory = inventoryBackupSchemas(root);
function streamFor(family: (typeof MIGRATION_STREAM_CONTRACTS)[number]['schemaFamily']) {
  const contract = MIGRATION_STREAM_CONTRACTS.find(
    (candidate) => candidate.schemaFamily === family && candidate.dialect === 'sqlite'
  );
  return inventory.inspectedStreams.find((candidate) => candidate.id === contract?.id);
}
const selection = {
  settings: true,
  users: false,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
};

it('pins every Phase 3 SQL dataset to one installed settings module and current table', () => {
  const identities = PHASE3_SQLITE_DATASET_REGISTRATIONS.map(
    ({ family, table }) => `${family}:${table}`
  );
  expect(new Set(identities).size).toBe(identities.length);
  expect(new Set(PHASE3_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id)).size).toBe(
    PHASE3_SQLITE_DATASET_REGISTRATIONS.length
  );

  for (const registration of PHASE3_SQLITE_DATASET_REGISTRATIONS) {
    expect(registration.dataset).toMatchObject({
      kind: 'settings',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    });
    expect(
      TENANT_DATASET_POLICIES.filter(
        (policy) =>
          policy.family === registration.family &&
          policy.table === registration.table &&
          policy.kind === 'settings'
      )
    ).toHaveLength(1);
    const stream = streamFor(registration.family);
    expect(stream?.tables.some((table) => table.name === registration.table)).toBe(true);
  }
});

it('keeps the user-specific permission partition out of the Phase 3 settings dataset', () => {
  const permission = PHASE3_SQLITE_DATASET_REGISTRATIONS.find(
    ({ table }) => table === 'resource_permissions'
  );
  expect(permission).toMatchObject({
    dataset: { id: 'core.resource_permissions.settings', module: 'authorization' },
    partitions: ['role', 'org'],
  });
  expect(
    PHASE3_SQLITE_DATASET_REGISTRATIONS.filter(({ partitions }) => partitions !== undefined)
  ).toHaveLength(1);
});

it('includes launcher definitions without user favorites and keeps global profiles external', () => {
  expect(
    PHASE3_SQLITE_DATASET_REGISTRATIONS.find(({ table }) => table === 'application_launchers')
  ).toMatchObject({ dataset: { module: 'applications', kind: 'settings' } });
  expect(
    PHASE3_SQLITE_DATASET_REGISTRATIONS.some(({ table }) => table === 'launcher_favorites')
  ).toBe(false);
  expect(
    PHASE3_SQLITE_DATASET_REGISTRATIONS.some(({ table }) => table === 'profile_registry')
  ).toBe(false);
});

it('has an executable capture schema for every Phase 3 SQL registration', () => {
  for (const group of PHASE3_SQLITE_TABLE_GROUPS) {
    const stream = streamFor(group.family);
    if (!stream) throw new Error(`missing_stream:${group.family}`);
    const plan = planSqliteTenantDatasets(group.family, stream.tables, selection);
    for (const table of group.tables) {
      const entry = plan.entries.find((candidate) => candidate.table === table);
      expect(entry?.concerns, `${group.family}:${table}`).toEqual([]);
      expect(entry?.capture, `${group.family}:${table}`).not.toBeNull();
    }
  }
});
