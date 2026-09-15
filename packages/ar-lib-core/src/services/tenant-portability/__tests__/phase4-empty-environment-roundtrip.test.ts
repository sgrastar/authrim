import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { renderPortableMigrationSql } from '../../../migrations/sql-portability';
import {
  createTenantBundleKeyEnvelope,
  unlockTenantBundleKeyEnvelope,
} from '../bundle-key-envelope';
import { decodeTenantBundle, encodeTenantBundle } from '../bundle-codec';
import type { TenantBundleManifestExpectation } from '../bundle-manifest';
import {
  decodeKeyManagerTenantBackupRow,
  encodeKeyManagerTenantBackupRow,
  KEY_MANAGER_TENANT_BACKUP_DATASET,
} from '../key-manager-dataset';
import { emptyKeyManagerTenantBackupSnapshot } from '../key-manager-portability';
import type { PlannedInstalledSqliteDataset } from '../installed-sqlite-datasets';
import { PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '../phase4-sqlite-modules';
import { createPhase4SqliteInspectionPolicies } from '../phase4-sqlite-references';
import {
  decryptUpstreamProviderSecret,
  encryptUpstreamProviderSecret,
  exportPortableUpstreamProviderSecretsRow,
  portableUpstreamProviderSecrets,
} from '../portable-upstream-provider-secrets';
import { exportPortableOauthClientSecretRow } from '../portable-client-secret';
import { planSqliteTenantDatasets } from '../sqlite-dataset-plan';
import { sqliteSnapshotRowInsert } from '../sqlite-row-codec';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
  sqliteSnapshotTriggers,
} from '../sqlite-snapshot';
import { sqliteSnapshotStartStatement } from '../sqlite-capture-plan';

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
  for (const migration of stream(family).migrations)
    database.exec(
      renderPortableMigrationSql(readFileSync(`${root}${migration.file}`, 'utf8'), 'sqlite')
    );
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function phase4Plan(): PlannedInstalledSqliteDataset[] {
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

function applySnapshot(database: DatabaseSync, planned: readonly PlannedInstalledSqliteDataset[]) {
  database.exec(SQLITE_SNAPSHOT_SCHEMA);
  for (const entry of planned) database.exec(sqliteSnapshotTriggers(entry.capture, 'json'));
  const start = sqliteSnapshotStartStatement(
    planned.map((entry) => entry.capture),
    'phase4-snapshot',
    'tenant-a',
    undefined,
    'json'
  );
  expect(database.prepare(start.sql).run(...start.params).changes).toBe(1);
}

function ordered(planned: readonly PlannedInstalledSqliteDataset[]) {
  const policies = createPhase4SqliteInspectionPolicies(planned);
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

async function* values<T>(items: readonly T[]) {
  yield* items;
}

describe('Phase 4 empty-environment roundtrip', () => {
  it('restores every dataset contract and target-encrypts representative protocol secrets', async () => {
    const planned = phase4Plan();
    const sourceCore = freshDatabase('core');
    const sourceAdmin = freshDatabase('admin');
    const targetCore = freshDatabase('core');
    const targetAdmin = freshDatabase('admin');
    const sourceKey = '11'.repeat(32);
    const targetKey = '22'.repeat(32);
    try {
      const sourceCiphertext = await encryptUpstreamProviderSecret('provider-secret', sourceKey);
      sourceCore.exec(`
        INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at)
        VALUES('tenant-a','TENANTA','tenant-key-a','Tenant A',1,1);
        INSERT INTO identity_providers(id,name,provider_type,config_json,enabled,created_at,updated_at,tenant_id)
        VALUES('saml-a','Campus SAML','saml','{}',1,1,1,'tenant-a');
        INSERT INTO credential_configurations(id,tenant_id,configuration_id,format,vct,is_active)
        VALUES('config-a','tenant-a','StudentCredential','dc+sd-jwt','StudentCredential',1);
        INSERT INTO upstream_providers(
          id,tenant_id,name,provider_type,client_id,client_secret_encrypted,created_at,updated_at
        ) VALUES('provider-a','tenant-a','Example OIDC','oidc','client-a','${sourceCiphertext}',1,1);
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
          .all('phase4-snapshot', 'tenant-a', '', 10_000)
          .map((row) => String(row.row_json));
        exported.set(
          entry.dataset.id,
          entry.dataset.id === 'core.oauth_clients'
            ? await Promise.all(rows.map((rowJson) => exportPortableOauthClientSecretRow(rowJson)))
            : entry.dataset.id === 'core.upstream_providers'
              ? await Promise.all(
                  rows.map((rowJson) =>
                    exportPortableUpstreamProviderSecretsRow(rowJson, sourceKey)
                  )
                )
              : rows
        );
      }

      const virtualRows = new Map<string, Uint8Array[]>([
        [
          KEY_MANAGER_TENANT_BACKUP_DATASET.id,
          [
            await encodeKeyManagerTenantBackupRow(
              'tenant-a',
              emptyKeyManagerTenantBackupSnapshot()
            ),
          ],
        ],
      ]);
      const datasets = [
        ...planned.map((entry) => entry.dataset),
        KEY_MANAGER_TENANT_BACKUP_DATASET,
      ];
      const key = await createTenantBundleKeyEnvelope('phase4-roundtrip-password');
      const envelope = key.envelope.slice();
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
          snapshotId: 'phase4-snapshot',
          boundaryUnixMs: 1,
          inventoryDigestSha256: 'ab'.repeat(32),
          datasets,
        },
        values(
          datasets.map((dataset) => ({
            datasetId: dataset.id,
            chunks: values(
              virtualRows.get(dataset.id) ??
                (exported.get(dataset.id) ?? []).map((row) => new TextEncoder().encode(row))
            ),
          }))
        ),
        key,
        expected
      ))
        artifact.push(bytes);
      expect(
        artifact.some((bytes) => new TextDecoder().decode(bytes).includes('provider-secret'))
      ).toBe(false);

      sourceCore.close();
      sourceAdmin.close();
      const restored = new Map(datasets.map((dataset) => [dataset.id, [] as string[]]));
      const restoredKey = await unlockTenantBundleKeyEnvelope(
        envelope,
        'phase4-roundtrip-password'
      );
      for await (const event of decodeTenantBundle(values(artifact), restoredKey, expected, {
        maxTotalBytes: 8 * 1024 * 1024,
        maxFrames: 8192,
      })) {
        if (event.kind === 'chunk')
          restored
            .get(event.datasetId)
            ?.push(new TextDecoder('utf-8', { fatal: true }).decode(event.bytes).trimEnd());
      }

      for (const policy of ordered(planned)) {
        const entry = planned.find((candidate) => candidate.dataset.id === policy.dataset.id)!;
        const target = entry.family === 'core' ? targetCore : targetAdmin;
        for (const rowJson of restored.get(entry.dataset.id) ?? []) {
          const fields = JSON.parse(rowJson) as Record<string, ['text' | 'null', string | null]>;
          for (const [column, override] of Object.entries(policy.restoreOverrides ?? {}))
            fields[column] = [...override];
          if (entry.dataset.id === 'core.upstream_providers') {
            const secrets = await portableUpstreamProviderSecrets(JSON.parse(rowJson));
            fields.client_secret_encrypted = [
              'text',
              secrets.clientSecret
                ? await encryptUpstreamProviderSecret(secrets.clientSecret, targetKey)
                : '',
            ];
          }
          const insert = sqliteSnapshotRowInsert(
            entry.capture.table,
            entry.capture.columns,
            JSON.stringify(fields)
          );
          target.prepare(insert.sql).run(...insert.params);
        }
      }

      expect(restored.size).toBe(datasets.length);
      expect(
        targetCore.prepare("SELECT name FROM identity_providers WHERE id='saml-a'").get()
      ).toEqual({ name: 'Campus SAML' });
      const restoredCiphertext = String(
        targetCore
          .prepare(
            "SELECT client_secret_encrypted value FROM upstream_providers WHERE id='provider-a'"
          )
          .get()!.value
      );
      expect(await decryptUpstreamProviderSecret(restoredCiphertext, targetKey)).toBe(
        'provider-secret'
      );
      expect(restoredCiphertext).not.toBe(sourceCiphertext);
      await expect(
        decodeKeyManagerTenantBackupRow(
          restored.get(KEY_MANAGER_TENANT_BACKUP_DATASET.id)![0],
          'tenant-a'
        )
      ).resolves.toEqual(emptyKeyManagerTenantBackupSnapshot());
      expect(targetCore.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(targetAdmin.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      for (const database of [sourceCore, sourceAdmin, targetCore, targetAdmin]) {
        try {
          database.close();
        } catch {
          // Source databases are deliberately closed before bundle decode.
        }
      }
    }
  });
});
