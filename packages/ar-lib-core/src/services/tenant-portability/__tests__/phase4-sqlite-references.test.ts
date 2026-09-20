import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import type { PlannedInstalledSqliteDataset } from '../installed-sqlite-datasets';
import { PHASE3_SQLITE_REFERENCE_RULES } from '../phase3-sqlite-references';
import {
  PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
  PHASE4_REBUILT_SQLITE_TABLES,
  PHASE4_SQLITE_DATASET_REGISTRATIONS,
} from '../phase4-sqlite-modules';
import {
  createPhase4SqliteInspectionPolicies,
  inspectPhase4SqliteReferences,
  phase4SqliteRestoreDependencies,
  phase4SqliteRestoreOverrides,
  PHASE4_SQLITE_REFERENCE_RULES,
} from '../phase4-sqlite-references';
import { planSqliteTenantDatasets } from '../sqlite-dataset-plan';
import type { PortableSqliteRow } from '../sqlite-dataset-inspector';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const inventory = inventoryBackupSchemas(root);
const registrations = new Map(
  PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map((registration) => [
    `${registration.family}:${registration.table}`,
    registration,
  ])
);
const selection = {
  settings: true,
  users: false,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
};

function stream(family: 'core' | 'admin') {
  const result = inventory.inspectedStreams.find((candidate) => candidate.id === `${family}-d1`);
  if (!result) throw new Error(`missing_stream:${family}`);
  return result;
}

function cumulativePlan(): PlannedInstalledSqliteDataset[] {
  const plans = new Map(
    (['core', 'admin'] as const).map((family) => [
      family,
      planSqliteTenantDatasets(family, stream(family).tables, selection),
    ])
  );
  return PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map((registration, ordinal) => {
    const capture = plans
      .get(registration.family as 'core' | 'admin')
      ?.entries.find((entry) => entry.table === registration.table)?.capture;
    if (!capture) throw new Error(`missing_capture:${registration.dataset.id}`);
    return {
      ordinal,
      firstOrdinal: registration.family === 'core' ? 0 : 1,
      resourceId: `${registration.family}-db`,
      family: registration.family,
      table: registration.table,
      capture,
      dataset: registration.dataset,
      ...(registration.partitions ? { partitions: registration.partitions } : {}),
    };
  });
}

function row(values: Record<string, string | null>): PortableSqliteRow {
  return Object.fromEntries(
    Object.entries(values).map(([column, value]) => [
      column,
      value === null ? (['null', null] as const) : (['text', value] as const),
    ])
  );
}

describe('Phase 4 installed SQL reference graph', () => {
  it('covers every declared foreign key between cumulative Phase 3 and 4 datasets', () => {
    const rules = [...PHASE3_SQLITE_REFERENCE_RULES, ...PHASE4_SQLITE_REFERENCE_RULES];
    for (const family of ['core', 'admin'] as const) {
      for (const table of stream(family).tables) {
        const from = registrations.get(`${family}:${table.name}`);
        if (!from) continue;
        for (const foreignKeys of Map.groupBy(
          table.foreignKeys,
          (foreignKey) => foreignKey.id
        ).values()) {
          const target = registrations.get(`${family}:${foreignKeys[0].parentTable}`);
          if (!target) continue;
          const localColumns = [...foreignKeys]
            .sort((left, right) => left.position - right.position)
            .map((foreignKey) => foreignKey.column);
          expect(
            rules.some(
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

  it('requires the tenant definition for every Phase 4 SQL record', () => {
    for (const registration of PHASE4_SQLITE_DATASET_REGISTRATIONS) {
      expect(
        PHASE4_SQLITE_REFERENCE_RULES.some(
          (rule) =>
            rule.fromDatasetId === registration.dataset.id &&
            rule.toDatasetId === 'core.tenants' &&
            JSON.stringify(rule.localColumns) === JSON.stringify(['tenant_id'])
        ),
        registration.dataset.id
      ).toBe(true);
    }
  });

  it('orders authoritative key and federation rows without introducing derived datasets', () => {
    expect(phase4SqliteRestoreDependencies('admin.key_material_refs')).toContain(
      'admin.key_versions'
    );
    expect(phase4SqliteRestoreDependencies('admin.key_versions')).toContain('admin.key_registries');
    expect(phase4SqliteRestoreDependencies('admin.federation_metadata_documents')).toContain(
      'admin.federation_trust_sources'
    );
    const ids = new Set(
      PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id)
    );
    for (const table of PHASE4_REBUILT_SQLITE_TABLES)
      expect([...ids].some((id) => id.endsWith(`.${table}`))).toBe(false);
  });

  it('retains nullable logical references for validation without creating restore cycles', () => {
    const identity = {
      module: 'credentials' as const,
      collection: 'admin.key_registries',
      id: 'registry-a',
      tenantId: 'tenant-a',
    };
    expect(
      inspectPhase4SqliteReferences(
        identity.collection,
        row({ tenant_id: 'tenant-a', active_version_id: 'version-a' }),
        identity
      ).map(({ to }) => [to.collection, to.id])
    ).toEqual([
      ['core.tenants', '[["text","tenant-a"]]'],
      ['admin.key_versions', '[["text","version-a"]]'],
    ]);
    expect(phase4SqliteRestoreDependencies(identity.collection)).toEqual(['core.tenants']);
  });

  it('resets target-encrypted and target-validated state before sidecar restore', () => {
    expect(phase4SqliteRestoreOverrides('core.upstream_providers')).toEqual({
      client_secret_encrypted: ['text', ''],
      private_key_jwk_encrypted: ['null', null],
    });
    expect(phase4SqliteRestoreOverrides('admin.federation_metadata_documents')).toEqual({
      validation_state: ['text', 'pending'],
      validated_at: ['null', null],
    });
  });

  it('closes SAML launcher, mapping and custom attribute-preset references', () => {
    const launcher = {
      module: 'applications' as const,
      collection: 'core.application_launchers',
      id: 'launcher-a',
      tenantId: 'tenant-a',
    };
    expect(
      inspectPhase4SqliteReferences(
        launcher.collection,
        row({
          tenant_id: 'tenant-a',
          id: 'launcher-a',
          config_json: JSON.stringify({
            id: 'launcher-a',
            application_type: 'saml_sp',
            application_id: 'provider-a',
          }),
        }),
        launcher
      ).map(({ to }) => [to.collection, to.id])
    ).toContainEqual(['core.identity_providers', '[["text","provider-a"]]']);

    const provider = {
      module: 'federation' as const,
      collection: 'core.identity_providers',
      id: 'provider-a',
      tenantId: 'tenant-a',
    };
    expect(
      inspectPhase4SqliteReferences(
        provider.collection,
        row({
          tenant_id: 'tenant-a',
          config_json: JSON.stringify({
            identityMapping: {
              fieldMappingSetId: 'set-a',
              fieldMappingVersionId: 'version-a',
            },
            attributePresetId: 'custom:preset-a',
          }),
        }),
        provider
      ).map(({ to }) => to.collection)
    ).toEqual([
      'core.tenants',
      'admin.field_mapping_sets',
      'admin.field_mapping_versions',
      'core.saml_attribute_presets',
    ]);
  });

  it('builds only a complete cumulative installed plan', () => {
    const planned = cumulativePlan();
    expect(createPhase4SqliteInspectionPolicies(planned)).toHaveLength(planned.length);
    expect(() => createPhase4SqliteInspectionPolicies(planned.slice(1))).toThrow(
      'backup_phase4_plan_incomplete'
    );
  });
});
