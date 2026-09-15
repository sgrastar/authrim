import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { MIGRATION_STREAM_CONTRACTS } from '../../control-plane/migration-stream-contract';
import { TENANT_DATASET_POLICIES } from '../dataset-registry';
import {
  PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
  PHASE4_REBUILT_SQLITE_TABLES,
  PHASE4_SQLITE_DATASET_REGISTRATIONS,
  PHASE4_SQLITE_TABLE_GROUPS,
} from '../phase4-sqlite-modules';
import { planSqliteTenantDatasets } from '../sqlite-dataset-plan';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const inventory = inventoryBackupSchemas(root);
const selection = {
  settings: true,
  users: false,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
};

function streamFor(family: (typeof MIGRATION_STREAM_CONTRACTS)[number]['schemaFamily']) {
  const contract = MIGRATION_STREAM_CONTRACTS.find(
    (candidate) => candidate.schemaFamily === family && candidate.dialect === 'sqlite'
  );
  return inventory.inspectedStreams.find((candidate) => candidate.id === contract?.id);
}

it('pins the Phase 4 protocol and credential SQL scope to installed settings modules', () => {
  expect(PHASE4_SQLITE_DATASET_REGISTRATIONS).toHaveLength(17);
  const identities = PHASE4_SQLITE_DATASET_REGISTRATIONS.map(
    ({ family, table }) => `${family}:${table}`
  );
  expect(new Set(identities).size).toBe(identities.length);
  expect(new Set(PHASE4_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id)).size).toBe(
    PHASE4_SQLITE_DATASET_REGISTRATIONS.length
  );
  expect(
    new Set(PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id)).size
  ).toBe(PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.length);

  for (const registration of PHASE4_SQLITE_DATASET_REGISTRATIONS) {
    expect(registration.dataset).toMatchObject({
      kind: 'settings',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    });
    expect(['federation', 'credentials']).toContain(registration.dataset.module);
    expect(
      TENANT_DATASET_POLICIES.filter(
        (policy) =>
          policy.family === registration.family &&
          policy.table === registration.table &&
          policy.kind === 'settings'
      )
    ).toHaveLength(1);
  }
});

it('has an executable tenant capture schema for every Phase 4 SQL registration', () => {
  for (const group of PHASE4_SQLITE_TABLE_GROUPS) {
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

it('keeps user migration state and connector observations out of the portable settings scope', () => {
  const tables = new Set(PHASE4_SQLITE_DATASET_REGISTRATIONS.map(({ table }) => table));
  expect(tables.has('directory_identity_links')).toBe(false);
  expect(tables.has('directory_jit_pending_users')).toBe(false);
  expect(tables.has('directory_auth_migration_user_states')).toBe(false);
  expect(tables.has('directory_auth_migration_transactions')).toBe(false);
  expect(tables.has('directory_connector_instances')).toBe(false);
  expect(tables.has('directory_connector_status_episodes')).toBe(false);
  expect(tables.has('credential_offers')).toBe(false);
  expect(tables.has('credential_secret_bodies')).toBe(false);
  expect(tables.has('credential_secret_metadata')).toBe(false);
  expect(tables.has('issued_credentials')).toBe(false);
  expect(PHASE4_REBUILT_SQLITE_TABLES).toEqual([
    'directory_connector_instances',
    'federation_entity_statements',
    'federation_metadata_entity_summaries',
    'federation_saml_runtime_entities',
    'federation_trust_chains',
    'federation_trust_context_snapshots',
  ]);
});
