import {
  loadRuntimeMappingGraph,
  resolveRuntimeIdentityMappingBinding,
} from '../../identity-mapping-runtime-resolver';
import { runtimeMappingSnapshotMatches } from '../../mapping-snapshot-equivalence';
import { sqliteAdapter } from '../../__tests__/identity-mapping-sqlite-fixture';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { renderPortableMigrationSql } from '../../../migrations/sql-portability';
import { decryptValue, encryptValue } from '../../../utils/pii-encryption';
import {
  createTenantBundleKeyEnvelope,
  unlockTenantBundleKeyEnvelope,
} from '../bundle-key-envelope';
import { decodeTenantBundle, encodeTenantBundle } from '../bundle-codec';
import type { TenantBundleManifestExpectation } from '../bundle-manifest';
import type { PlannedInstalledSqliteDataset } from '../installed-sqlite-datasets';
import { PHASE3_SQLITE_DATASET_REGISTRATIONS } from '../phase3-sqlite-modules';
import { createPhase3SqliteInspectionPolicies } from '../phase3-sqlite-references';
import { exportPortableOauthClientSecretRow } from '../portable-client-secret';
import { planSqliteTenantDatasets } from '../sqlite-dataset-plan';
import { sqliteSnapshotRowInsert } from '../sqlite-row-codec';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
  sqliteSnapshotTriggers,
} from '../sqlite-snapshot';
import { sqliteSnapshotStartStatement } from '../sqlite-capture-plan';
import { verifyPhase3LogicalReferences } from '../phase3-logical-references';
import type { TenantBackupStepContext } from '../operation-executor';

const restoreContext: TenantBackupStepContext = {
  operation: {
    id: 'destination-restore',
    tenant_id: 'tenant-a',
    kind: 'import',
    idempotency_key: 'restore',
    request_digest: 'digest',
    state: 'running',
    phase: 'restore_sqlite',
    cursor_json: null,
    created_by: 'admin',
    created_at: 1,
    updated_at: 1,
    revision: 1,
    fencing_token: 1,
    lease_owner: 'worker',
    lease_expires_at: 100,
    next_attempt_at: 1,
    failure_count: 0,
    last_error_code: null,
  },
  lease: {
    operationId: 'destination-restore',
    tenantId: 'tenant-a',
    owner: 'worker',
    fencingToken: 1,
  },
  signal: new AbortController().signal,
};

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const inventory = inventoryBackupSchemas(root);
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

function freshDatabase(family: 'core' | 'admin') {
  const database = new DatabaseSync(':memory:');
  for (const migration of stream(family).migrations) {
    database.exec(
      renderPortableMigrationSql(readFileSync(`${root}${migration.file}`, 'utf8'), 'sqlite')
    );
  }
  database.exec('PRAGMA foreign_keys = ON');
  expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  return database;
}

function phase3Plan(): PlannedInstalledSqliteDataset[] {
  const plans = new Map(
    (['core', 'admin'] as const).map((family) => [
      family,
      planSqliteTenantDatasets(family, stream(family).tables, selection),
    ])
  );
  return PHASE3_SQLITE_DATASET_REGISTRATIONS.map((registration, ordinal) => {
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

function applySnapshot(database: DatabaseSync, planned: readonly PlannedInstalledSqliteDataset[]) {
  database.exec(SQLITE_SNAPSHOT_SCHEMA);
  for (const entry of planned) database.exec(sqliteSnapshotTriggers(entry.capture, 'json'));
  const start = sqliteSnapshotStartStatement(
    planned.map((entry) => entry.capture),
    'phase3-snapshot',
    'tenant-a',
    undefined,
    'json'
  );
  expect(database.prepare(start.sql).run(...start.params).changes).toBe(1);
}

function ordered(planned: readonly PlannedInstalledSqliteDataset[]) {
  const policies = createPhase3SqliteInspectionPolicies(planned);
  const byId = new Map(policies.map((policy) => [policy.dataset.id, policy]));
  const result: typeof policies = [];
  const visited = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const policy = byId.get(id);
    if (!policy) throw new Error(`missing_policy:${id}`);
    for (const dependency of policy.restoreAfter ?? []) visit(dependency);
    result.push(policy);
  }
  for (const id of byId.keys()) visit(id);
  return result;
}

function adapter(database: DatabaseSync) {
  return {
    query: async <T>(sql: string, params: unknown[] = []) =>
      database.prepare(sql).all(...(params as never[])) as T[],
  };
}

async function* values<T>(items: readonly T[]) {
  yield* items;
}

describe('Phase 3 empty-environment roundtrip', () => {
  it.each(['legitimate', 'changed-graph-forged-pin', 'changed-action-without-snapshots'])(
    'restores datasets without trusting imported pins: %s',
    async (scenario) => {
      const planned = phase3Plan();
      const sourceCore = freshDatabase('core');
      const sourceAdmin = freshDatabase('admin');
      const targetCore = freshDatabase('core');
      const targetAdmin = freshDatabase('admin');
      const sourceKey = '11'.repeat(32);
      const targetKey = '22'.repeat(32);
      try {
        const encrypted = await encryptValue(
          'portable-webhook-secret',
          sourceKey,
          'AES-256-GCM',
          1
        );
        sourceCore.exec(`
        INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at)
        VALUES('tenant-a','TENANTA','tenant-key-a','Tenant A',1,1);
        INSERT INTO oauth_clients(
          tenant_id,client_id,client_name,redirect_uris,grant_types,response_types,created_at,updated_at,
          logout_webhook_secret_encrypted
        ) VALUES('tenant-a','client-a','Client A','[]','["authorization_code"]','["code"]',1,1,'${encrypted.encrypted}');
        INSERT INTO roles(id,tenant_id,name,permissions_json,created_at)
        VALUES('role-0-parent','tenant-a','Parent','[]',1);
        INSERT INTO roles(id,tenant_id,name,permissions_json,created_at,parent_role_id)
        VALUES('role-1-child','tenant-a','Child','[]',1,'role-0-parent');
        INSERT INTO consent_statements(id,tenant_id,slug,created_at,updated_at)
        VALUES('statement-a','tenant-a','terms',1,1);
        INSERT INTO consent_statement_versions(
          id,tenant_id,statement_id,version,effective_at,created_at,updated_at
        ) VALUES('statement-version-a','tenant-a','statement-a','20260915',1,1,1);
        -- An organisation as the Admin API wrote it before core migration 024.
        INSERT INTO organizations(id,tenant_id,name,org_type,created_at,updated_at)
        VALUES('org-a','tenant-a','acme','team',1,1);
      `);
        sourceAdmin.exec(`
        INSERT INTO tenant_settings_documents(
          tenant_id,scope_type,scope_id,category,document_json,version,revision,
          projection_state,updated_at,projected_at
        ) VALUES('tenant-a','tenant','tenant-a','branding','{}','sha256:0123456789abcdef',1,'applied',1,1);
        INSERT INTO attribute_field_registry(
          id,tenant_id,owner_scope_type,protocol,field_key,display_name,surfaces_json,created_at,updated_at
        ) VALUES('field-a','tenant-a','tenant','oidc','department','Department','["userinfo"]',1,1);
        INSERT INTO attribute_group_registry(
          id,tenant_id,owner_scope_type,protocol,group_type,group_key,display_name,field_keys_json,
          created_at,updated_at
        ) VALUES('group-a','tenant-a','tenant','oidc','custom','staff','Staff','["department"]',1,1);
      `);

        sourceAdmin.exec(`
        INSERT INTO field_mapping_sets (id,tenant_id,field_mapping_key,display_name,lifecycle_state,created_at,updated_at)
          VALUES ('graph-set','tenant-a','graph','Graph','active',1,1);
        INSERT INTO field_mapping_versions (id,tenant_id,field_mapping_set_id,version_label,lifecycle_state,field_mapping_hash,created_at,updated_at)
          VALUES ('graph-version','tenant-a','graph-set','v1','published','graph-hash',1,1);
        INSERT INTO mapping_rules (id,tenant_id,field_mapping_version_id,rule_key,rule_kind,action,created_at,updated_at,output_step_id,target_ref_json)
          VALUES ('chain-rule','tenant-a','graph-version','chain','mapping','allow',1,1,'trim-step','{"side":"canonical","namespace":"authrim.profile","path":"display_name"}'),
                 ('identifier-rule','tenant-a','graph-version','identifier','mapping','allow',1,1,'identifier-step','{"side":"destination","namespace":"oidc.claim","path":"sub"}');
        INSERT INTO mapping_rule_edges (id,tenant_id,rule_id,source_ref_json,target_ref_json,display_order,created_at,updated_at)
          VALUES ('given-edge','tenant-a','chain-rule','{"side":"source","namespace":"authrim.profile","path":"given_name"}','{"side":"canonical","namespace":"authrim.profile","path":"display_name"}',0,1,1),
                 ('family-edge','tenant-a','chain-rule','{"side":"source","namespace":"authrim.profile","path":"family_name"}','{"side":"canonical","namespace":"authrim.profile","path":"display_name"}',1,1,1);
        INSERT INTO mapping_transform_steps (id,tenant_id,rule_id,step_order,operation,parameters_json,created_at,updated_at)
          VALUES ('concat-step','tenant-a','chain-rule',0,'concat','{"delimiter":" "}',1,1),
                 ('trim-step','tenant-a','chain-rule',1,'trim','{}',1,1),
                 ('identifier-step','tenant-a','identifier-rule',0,'persistent_identifier','{"input":"account","format":"plain","algorithm":"authrim_sha256"}',1,1);
        INSERT INTO mapping_transform_step_inputs (tenant_id,step_id,position,edge_id,input_step_id,name)
          VALUES ('tenant-a','concat-step',0,'given-edge',NULL,'given'),
                 ('tenant-a','concat-step',1,'family-edge',NULL,'family'),
                 ('tenant-a','trim-step',0,NULL,'concat-step','full');
      `);

        // An attacker can author a valid encrypted bundle, including self-asserted metadata.
        sourceAdmin.exec(`
        INSERT INTO field_catalogs (id,tenant_id,catalog_key,display_name,lifecycle_state,created_at,updated_at)
          VALUES ('graph-catalog','tenant-a','graph','Graph','active',1,1);
        INSERT INTO field_catalog_versions (id,tenant_id,catalog_id,version_label,bundle_hash,lifecycle_state,created_at,updated_at)
          VALUES ('graph-catalog-version','tenant-a','graph-catalog','v1','catalog-hash','active',1,1);
        INSERT INTO compiled_mapping_snapshots (id,tenant_id,field_mapping_version_id,catalog_version_id,snapshot_hash,lifecycle_state,compiled_at,metadata_json)
          VALUES ('graph-snapshot','tenant-a','graph-version','graph-catalog-version','current-hash','active',1,
          '{"dependencyGraphId":"graph_023_graph-snapshot","preserved":"value","graphMigration023":{"previousSnapshotHash":"forged-old-hash","snapshotHash":"current-hash"}}');
        INSERT INTO field_mapping_activations (id,tenant_id,field_mapping_set_id,field_mapping_version_id,activation_scope_json,lifecycle_state,activated_at,created_at,updated_at)
          VALUES ('graph-activation','tenant-a','graph-set','graph-version','{"kind":"tenant"}','active',1,1,1);
      `);

        if (scenario === 'changed-graph-forged-pin') {
          sourceAdmin
            .prepare('UPDATE mapping_transform_steps SET parameters_json=? WHERE id=?')
            .run('{"delimiter":"attacker"}', 'concat-step');
          // The encrypted bundle keeps an existing evidence/VP pin despite a different graph.
          sourceAdmin
            .prepare(
              'UPDATE compiled_mapping_snapshots SET snapshot_hash=?,metadata_json=? WHERE id=?'
            )
            .run('current-hash', '{"snapshotPinState":"compiled"}', 'graph-snapshot');
        }
        if (scenario === 'changed-action-without-snapshots') {
          sourceAdmin.exec(`
            DELETE FROM compiled_mapping_snapshots;
            UPDATE mapping_rules SET action='deny' WHERE id='chain-rule';
            UPDATE field_mapping_versions SET restore_id='uploaded-restore-id';
          `);
        }

        const corePlan = planned.filter((entry) => entry.family === 'core');
        const adminPlan = planned.filter((entry) => entry.family === 'admin');
        applySnapshot(sourceCore, corePlan);
        applySnapshot(sourceAdmin, adminPlan);

        const exported = new Map<string, string[]>();
        for (const entry of planned) {
          const source = entry.family === 'core' ? sourceCore : sourceAdmin;
          const rows = source
            .prepare(sqliteSnapshotPageQuery(entry.capture, 'json', entry.partitions))
            .all('phase3-snapshot', 'tenant-a', '', 10_000)
            // A progress row (row_json NULL) only moves past other tenants' rows.
            .filter((row) => row.row_json !== null)
            .map((row) => String(row.row_json));
          exported.set(
            entry.dataset.id,
            entry.dataset.id === 'core.oauth_clients'
              ? await Promise.all(
                  rows.map((row) => exportPortableOauthClientSecretRow(row, sourceKey))
                )
              : rows
          );
        }

        const key = await createTenantBundleKeyEnvelope('phase3-roundtrip-password');
        const envelope = key.envelope.slice();
        const datasets = planned.map((entry) => entry.dataset);
        const expected: TenantBundleManifestExpectation = {
          bundleId: [...envelope.slice(1, 17)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join(''),
          source: {
            tenantId: 'tenant-a',
            issuer: 'https://issuer.example',
            productVersion: '0.4.2',
          },
          selection,
          datasets,
        };
        const artifact: Uint8Array[] = [];
        for await (const bytes of encodeTenantBundle(
          {
            formatVersion: 1,
            bundleId: expected.bundleId,
            source: expected.source,
            selection,
            snapshotId: 'phase3-snapshot',
            boundaryUnixMs: 1,
            inventoryDigestSha256: 'ab'.repeat(32),
            datasets,
          },
          values(
            planned.map((entry) => ({
              datasetId: entry.dataset.id,
              chunks: values(
                (exported.get(entry.dataset.id) ?? []).map((row) => new TextEncoder().encode(row))
              ),
            }))
          ),
          key,
          expected
        ))
          artifact.push(bytes);
        expect(
          artifact.some((bytes) =>
            new TextDecoder().decode(bytes).includes('portable-webhook-secret')
          )
        ).toBe(false);

        sourceCore.close();
        sourceAdmin.close();
        const restored = new Map(datasets.map((dataset) => [dataset.id, [] as string[]]));
        const restoredKey = await unlockTenantBundleKeyEnvelope(
          envelope,
          'phase3-roundtrip-password'
        );
        for await (const event of decodeTenantBundle(values(artifact), restoredKey, expected, {
          maxTotalBytes: 4 * 1024 * 1024,
          maxFrames: 4096,
        })) {
          if (event.kind === 'chunk')
            restored
              .get(event.datasetId)
              ?.push(new TextDecoder('utf-8', { fatal: true }).decode(event.bytes));
        }

        for (const policy of ordered(planned)) {
          const entry = planned.find((candidate) => candidate.dataset.id === policy.dataset.id)!;
          const target = entry.family === 'core' ? targetCore : targetAdmin;
          for (const sourceRow of restored.get(entry.dataset.id) ?? []) {
            // The restore step writes each row through the policy's installed transform.
            const rowJson = policy.restoreTransform
              ? await policy.restoreTransform.transform(restoreContext, sourceRow, 'write')
              : sourceRow;
            const fields = JSON.parse(rowJson) as Record<string, ['text' | 'null', string | null]>;
            if (
              entry.dataset.id === 'core.oauth_clients' &&
              fields.logout_webhook_secret_encrypted
            ) {
              const portableValue = fields.logout_webhook_secret_encrypted[1];
              const portable = portableValue
                ? (JSON.parse(portableValue) as { version: unknown; kind: unknown; value: unknown })
                : null;
              if (
                portable &&
                (portable.version !== 1 ||
                  portable.kind !== 'oauth_logout_webhook_secret' ||
                  typeof portable.value !== 'string')
              )
                throw new Error('invalid_portable_secret_fixture');
              fields.logout_webhook_secret_encrypted = portable
                ? [
                    'text',
                    (await encryptValue(portable.value as string, targetKey, 'AES-256-GCM', 2))
                      .encrypted,
                  ]
                : ['null', null];
            }
            const insert = sqliteSnapshotRowInsert(
              entry.capture.table,
              entry.capture.columns,
              JSON.stringify(fields)
            );
            target.prepare(insert.sql).run(...insert.params);
          }
        }

        const binding = await resolveRuntimeIdentityMappingBinding(sqliteAdapter(targetAdmin), {
          tenantId: 'tenant-a',
          protocol: 'oidc',
          role: 'op',
          fieldMappingSetId: 'graph-set',
          fieldMappingVersionId: 'graph-version',
        });
        expect(targetAdmin.prepare('SELECT restore_id FROM field_mapping_versions').all()).toEqual([
          { restore_id: 'destination-restore' },
        ]);
        const graph = await loadRuntimeMappingGraph(
          sqliteAdapter(targetAdmin),
          'tenant-a',
          'graph-version'
        );
        expect(graph.graphRules).toHaveLength(2);
        if (scenario === 'changed-action-without-snapshots') {
          expect(binding).toBeNull();
          expect(targetAdmin.prepare('SELECT * FROM compiled_mapping_snapshots').all()).toEqual([]);
          expect(
            targetAdmin.prepare("SELECT action FROM mapping_rules WHERE id='chain-rule'").get()
          ).toEqual({ action: 'deny' });
        } else {
          if (!binding) throw new Error('restored mapping missing');
          expect(binding.mappingSnapshotPinTrusted).toBe(false);
          expect(runtimeMappingSnapshotMatches(binding, 'current-hash')).toBe(false);
          expect(runtimeMappingSnapshotMatches(binding, 'forged-old-hash')).toBe(false);
        }
        if (scenario === 'legitimate')
          expect(
            targetAdmin
              .prepare(
                "SELECT metadata_json FROM compiled_mapping_snapshots WHERE id='graph-snapshot'"
              )
              .get()
          ).toEqual({
            metadata_json: JSON.stringify({
              dependencyGraphId: 'graph_023_graph-snapshot',
              preserved: 'value',
              snapshotPinState: 'requires_recompile',
            }),
          });

        expect(restored.size).toBe(PHASE3_SQLITE_DATASET_REGISTRATIONS.length);
        expect(targetCore.prepare("SELECT name FROM tenants WHERE id='tenant-a'").get()).toEqual({
          name: 'Tenant A',
        });
        expect(
          targetCore.prepare("SELECT parent_role_id FROM roles WHERE id='role-1-child'").get()
        ).toEqual({ parent_role_id: 'role-0-parent' });
        expect(
          targetCore.prepare("SELECT org_type FROM organizations WHERE id='org-a'").get()
        ).toEqual({ org_type: 'department' });
        const storedSecret = String(
          targetCore
            .prepare(
              "SELECT logout_webhook_secret_encrypted value FROM oauth_clients WHERE tenant_id='tenant-a' AND client_id='client-a'"
            )
            .get()!.value
        );
        expect((await decryptValue(storedSecret, targetKey)).decrypted).toBe(
          'portable-webhook-secret'
        );
        expect(storedSecret).not.toBe(encrypted.encrypted);
        await expect(
          verifyPhase3LogicalReferences({
            tenantId: 'tenant-a',
            admin: adapter(targetAdmin),
          })
        ).resolves.toBeUndefined();
        expect(
          targetAdmin
            .prepare(
              'SELECT step_id,position,edge_id,input_step_id,name FROM mapping_transform_step_inputs ORDER BY step_id,position'
            )
            .all()
        ).toEqual([
          {
            step_id: 'concat-step',
            position: 0,
            edge_id: 'given-edge',
            input_step_id: null,
            name: 'given',
          },
          {
            step_id: 'concat-step',
            position: 1,
            edge_id: 'family-edge',
            input_step_id: null,
            name: 'family',
          },
          {
            step_id: 'trim-step',
            position: 0,
            edge_id: null,
            input_step_id: 'concat-step',
            name: 'full',
          },
        ]);
        expect(
          targetAdmin
            .prepare("SELECT output_step_id FROM mapping_rules WHERE id='identifier-rule'")
            .get()
        ).toEqual({ output_step_id: 'identifier-step' });
        expect(targetCore.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(targetAdmin.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        for (const database of [sourceCore, sourceAdmin, targetCore, targetAdmin]) {
          try {
            database.close();
          } catch {
            // Sources are deliberately closed before restore to prove source independence.
          }
        }
      }
    }
  );
});
