import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { MIGRATION_STREAM_CONTRACTS } from '../../control-plane/migration-stream-contract';
import { PHASE3_SQLITE_DATASET_REGISTRATIONS } from '../phase3-sqlite-modules';
import {
  inspectPhase3SqliteReferences,
  phase3SqliteDeferredColumns,
  phase3SqliteRestoreOverrides,
  phase3SqliteRestoreDependencies,
  phase3SqliteVerificationIgnoredColumns,
  PHASE3_SQLITE_REFERENCE_RULES,
} from '../phase3-sqlite-references';
import type { PortableSqliteRow } from '../sqlite-dataset-inspector';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const inventory = inventoryBackupSchemas(root);
const registrations = new Map(
  PHASE3_SQLITE_DATASET_REGISTRATIONS.map((registration) => [
    `${registration.family}:${registration.table}`,
    registration,
  ])
);

function row(values: Record<string, string | null>): PortableSqliteRow {
  return Object.fromEntries(
    Object.entries(values).map(([column, value]) => [
      column,
      value === null ? (['null', null] as const) : (['text', value] as const),
    ])
  );
}

function streamFor(family: 'core' | 'admin') {
  const contract = MIGRATION_STREAM_CONTRACTS.find(
    (candidate) => candidate.schemaFamily === family && candidate.dialect === 'sqlite'
  );
  return inventory.inspectedStreams.find((candidate) => candidate.id === contract?.id);
}

describe('Phase 3 installed SQL reference graph', () => {
  it('covers every declared foreign key between registered Phase 3 datasets', () => {
    for (const family of ['core', 'admin'] as const) {
      const stream = streamFor(family);
      if (!stream) throw new Error(`missing_stream:${family}`);
      for (const table of stream.tables) {
        const from = registrations.get(`${family}:${table.name}`);
        if (!from) continue;
        const grouped = Map.groupBy(table.foreignKeys, (foreignKey) => foreignKey.id);
        for (const foreignKeys of grouped.values()) {
          const target = registrations.get(`${family}:${foreignKeys[0].parentTable}`);
          if (!target) continue;
          const localColumns = [...foreignKeys]
            .sort((left, right) => left.position - right.position)
            .map((foreignKey) => foreignKey.column);
          expect(
            PHASE3_SQLITE_REFERENCE_RULES.some(
              (rule) =>
                rule.fromDatasetId === from.dataset.id &&
                rule.toDatasetId === target.dataset.id &&
                JSON.stringify(rule.localColumns) === JSON.stringify(localColumns)
            ),
            `${family}:${table.name}(${localColumns.join(',')}) -> ${foreignKeys[0].parentTable}`
          ).toBe(true);
        }
      }
    }
  });

  it('requires the tenant definition for every other Phase 3 SQL record', () => {
    const tenantDataset = registrations.get('core:tenants')?.dataset;
    if (!tenantDataset) throw new Error('missing_tenant_dataset');
    for (const registration of PHASE3_SQLITE_DATASET_REGISTRATIONS) {
      if (registration.table === 'tenants') continue;
      expect(
        PHASE3_SQLITE_REFERENCE_RULES.some(
          (rule) =>
            rule.fromDatasetId === registration.dataset.id &&
            rule.toDatasetId === tenantDataset.id &&
            JSON.stringify(rule.localColumns) === JSON.stringify(['tenant_id'])
        ),
        registration.dataset.id
      ).toBe(true);
    }
  });

  it('resolves settings permission subjects without introducing user dependencies', () => {
    const identity = {
      module: 'authorization',
      collection: 'core.resource_permissions.settings',
      id: 'permission',
      tenantId: 'tenant-a',
    };
    const role = inspectPhase3SqliteReferences(
      identity.collection,
      row({ tenant_id: 'tenant-a', subject_type: 'role', subject_id: 'role-a' }),
      identity
    );
    expect(role.map(({ to }) => [to.collection, to.id])).toEqual([
      ['core.tenants', '[["text","tenant-a"]]'],
      ['core.roles', '[["text","role-a"]]'],
    ]);

    const user = inspectPhase3SqliteReferences(
      identity.collection,
      row({ tenant_id: 'tenant-a', subject_type: 'user', subject_id: 'user-a' }),
      identity
    );
    expect(user.map(({ to }) => to.collection)).toEqual(['core.tenants']);
  });

  it('skips a nullable empty reference and rejects a missing required identity part', () => {
    const identity = {
      module: 'authorization',
      collection: 'core.organizations',
      id: 'org',
      tenantId: 'tenant-a',
    };
    expect(
      inspectPhase3SqliteReferences(
        identity.collection,
        row({ tenant_id: 'tenant-a', parent_org_id: null }),
        identity
      ).map(({ to }) => to.collection)
    ).toEqual(['core.tenants']);
    expect(() =>
      inspectPhase3SqliteReferences(
        'core.web_origin_registry',
        row({ tenant_id: 'tenant-a', client_id: null }),
        { ...identity, collection: 'core.web_origin_registry' }
      )
    ).toThrow('backup_phase3_reference_null');
  });

  it('accepts only the bundle-only form of an OAuth client environment secret', () => {
    const identity = {
      module: 'applications' as const,
      collection: 'core.oauth_clients',
      id: 'client',
      tenantId: 'tenant-a',
    };
    const portable = JSON.stringify({
      version: 1,
      kind: 'oauth_logout_webhook_secret',
      value: 'fixture-secret',
    });
    expect(
      inspectPhase3SqliteReferences(
        identity.collection,
        row({
          tenant_id: 'tenant-a',
          client_id: 'client-a',
          logout_webhook_secret_encrypted: portable,
        }),
        identity
      ).map(({ to }) => to.collection)
    ).toEqual(['core.tenants']);
    expect(() =>
      inspectPhase3SqliteReferences(
        identity.collection,
        row({
          tenant_id: 'tenant-a',
          client_id: 'client-a',
          logout_webhook_secret_encrypted: 'enc:v1:gcm:source-ciphertext',
        }),
        identity
      )
    ).toThrow('backup_portable_client_secret_invalid');
  });

  it('contains no duplicate installed rules', () => {
    const identities = PHASE3_SQLITE_REFERENCE_RULES.map((rule) =>
      JSON.stringify([
        rule.fromDatasetId,
        rule.localColumns,
        rule.toDatasetId,
        rule.nullable ?? false,
        rule.when ?? null,
      ])
    );
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('orders storage parents before children without creating profile activation cycles', () => {
    expect(phase3SqliteRestoreDependencies('core.client_consent_overrides')).toEqual([
      'core.consent_statements',
      'core.oauth_clients',
      'core.tenants',
    ]);
    expect(phase3SqliteRestoreDependencies('admin.destination_profile_versions')).toContain(
      'admin.destination_profiles'
    );
    expect(phase3SqliteRestoreDependencies('admin.destination_profiles')).not.toContain(
      'admin.destination_profile_versions'
    );
    expect(phase3SqliteRestoreDependencies('core.roles')).toEqual(['core.tenants']);
    expect(phase3SqliteDeferredColumns('core.roles')).toEqual(['parent_role_id']);
    expect(phase3SqliteDeferredColumns('core.organizations')).toEqual(['parent_org_id']);
    expect(phase3SqliteDeferredColumns('admin.destination_profiles')).toEqual(['base_profile_id']);
    expect(phase3SqliteDeferredColumns('admin.source_profiles')).toEqual([]);
    expect(phase3SqliteRestoreOverrides('admin.tenant_settings_documents')).toEqual({
      projection_state: ['text', 'pending'],
      projected_at: ['null', null],
    });
    expect(phase3SqliteRestoreOverrides('core.oauth_clients')).toEqual({
      logout_webhook_secret_encrypted: ['null', null],
    });
    expect(phase3SqliteVerificationIgnoredColumns('core.oauth_clients')).toEqual([
      'logout_webhook_secret_encrypted',
    ]);
    expect(phase3SqliteVerificationIgnoredColumns('core.tenants')).toEqual([]);
    expect(phase3SqliteRestoreOverrides('core.tenants')).toBeUndefined();
    expect(() => phase3SqliteRestoreDependencies('unknown')).toThrow(
      'backup_phase3_reference_dataset'
    );
  });

  it('keeps the installed cross-dataset restore graph complete and acyclic', () => {
    const remaining = new Map(
      PHASE3_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => [
        dataset.id,
        new Set(phase3SqliteRestoreDependencies(dataset.id)),
      ])
    );
    const restored = new Set<string>();
    while (remaining.size) {
      const ready = [...remaining].filter(([, dependencies]) =>
        [...dependencies].every((dependency) => restored.has(dependency))
      );
      expect(ready.length).toBeGreaterThan(0);
      for (const [datasetId] of ready) {
        remaining.delete(datasetId);
        restored.add(datasetId);
      }
    }
    expect(restored.size).toBe(PHASE3_SQLITE_DATASET_REGISTRATIONS.length);
  });

  it('uses installed source columns and target primary-key arity for every rule', () => {
    const byDataset = new Map(
      PHASE3_SQLITE_DATASET_REGISTRATIONS.map((registration) => [
        registration.dataset.id,
        registration,
      ])
    );
    for (const rule of PHASE3_SQLITE_REFERENCE_RULES) {
      const from = byDataset.get(rule.fromDatasetId);
      const target = byDataset.get(rule.toDatasetId);
      if (!from || !target || !['core', 'admin'].includes(from.family))
        throw new Error('missing_reference_registration');
      const sourceTable = streamFor(from.family as 'core' | 'admin')?.tables.find(
        ({ name }) => name === from.table
      );
      const targetTable = streamFor(target.family as 'core' | 'admin')?.tables.find(
        ({ name }) => name === target.table
      );
      expect(sourceTable, rule.fromDatasetId).toBeDefined();
      expect(targetTable, rule.toDatasetId).toBeDefined();
      expect(
        rule.localColumns.every((column) =>
          sourceTable?.columns.some(({ name }) => name === column)
        )
      ).toBe(true);
      if (rule.when) {
        expect(sourceTable?.columns.some(({ name }) => name === rule.when?.column)).toBe(true);
      }
      expect(
        targetTable?.columns.filter(({ primaryKeyPosition }) => primaryKeyPosition > 0).length
      ).toBe(rule.localColumns.length);
      if (rule.fromDatasetId === rule.toDatasetId) {
        expect(rule.nullable).toBe(true);
        expect(
          rule.localColumns.every(
            (column) => !sourceTable?.columns.find(({ name }) => name === column)?.notNull
          )
        ).toBe(true);
      }
      if (rule.restoreOrdering === 'validation-only') {
        const matchingForeignKey = [
          ...Map.groupBy(sourceTable?.foreignKeys ?? [], (foreignKey) => foreignKey.id).values(),
        ].some(
          (foreignKeys) =>
            foreignKeys[0]?.parentTable === targetTable?.name &&
            JSON.stringify(
              [...foreignKeys]
                .sort((left, right) => left.position - right.position)
                .map(({ column }) => column)
            ) === JSON.stringify(rule.localColumns)
        );
        expect(matchingForeignKey).toBe(false);
      }
    }
  });
});
