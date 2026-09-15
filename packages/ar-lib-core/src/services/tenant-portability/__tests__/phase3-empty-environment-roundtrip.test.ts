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
    database.exec('BEGIN');
    try {
      database.exec(
        renderPortableMigrationSql(readFileSync(`${root}${migration.file}`, 'utf8'), 'sqlite')
      );
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  database.exec('PRAGMA foreign_keys = ON');
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
  it('restores every installed dataset contract and representative records into fresh D1 schemas', async () => {
    const planned = phase3Plan();
    const sourceCore = freshDatabase('core');
    const sourceAdmin = freshDatabase('admin');
    const targetCore = freshDatabase('core');
    const targetAdmin = freshDatabase('admin');
    const sourceKey = '11'.repeat(32);
    const targetKey = '22'.repeat(32);
    try {
      const encrypted = await encryptValue('portable-webhook-secret', sourceKey, 'AES-256-GCM', 1);
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
        for (const rowJson of restored.get(entry.dataset.id) ?? []) {
          const fields = JSON.parse(rowJson) as Record<string, ['text' | 'null', string | null]>;
          if (entry.dataset.id === 'core.oauth_clients' && fields.logout_webhook_secret_encrypted) {
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

      expect(restored.size).toBe(PHASE3_SQLITE_DATASET_REGISTRATIONS.length);
      expect(targetCore.prepare("SELECT name FROM tenants WHERE id='tenant-a'").get()).toEqual({
        name: 'Tenant A',
      });
      expect(
        targetCore.prepare("SELECT parent_role_id FROM roles WHERE id='role-1-child'").get()
      ).toEqual({ parent_role_id: 'role-0-parent' });
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
          admin: adapter(targetAdmin) as never,
        })
      ).resolves.toBeUndefined();
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
  });
});
