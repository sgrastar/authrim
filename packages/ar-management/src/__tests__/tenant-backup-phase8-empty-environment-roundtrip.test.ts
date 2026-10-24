import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  createTenantBundleKeyEnvelope,
  unlockTenantBundleKeyEnvelope,
} from '@authrim/ar-lib-core/services/tenant-portability/bundle-key-envelope';
import {
  decodeTenantBundle,
  encodeTenantBundle,
} from '@authrim/ar-lib-core/services/tenant-portability/bundle-codec';
import type { TenantBundleManifestExpectation } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { selectInstalledSqliteDatasets } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-modules';
import { createPhase8SqliteInspectionPolicies } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-references';
import { portableLinkedIdentityTokens } from '@authrim/ar-lib-core/services/tenant-portability/portable-linked-identity-tokens';
import { portableTotpSecret } from '@authrim/ar-lib-core/services/tenant-portability/portable-totp-secret';
import {
  normalizePortableTenantKeyRow,
  portableTenantKeyColumn,
  PORTABLE_TENANT_KEY,
  PORTABLE_TENANT_KEY_SQLITE_DATASETS,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-tenant-key';
import {
  decryptUpstreamProviderSecret,
  encryptUpstreamProviderSecret,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-upstream-provider-secrets';
import { sqliteSnapshotRowInsert } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-row-codec';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
  sqliteSnapshotTriggers,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-snapshot';
import { sqliteSnapshotStartStatement } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-capture-plan';
import { decryptValue, encryptValue } from '@authrim/ar-lib-core/utils/pii-encryption';
import { hashPassword, verifyPassword } from '@authrim/ar-lib-core/utils/crypto';
import {
  createPhase8TenantBackupRowFilter,
  createPhase8TenantBackupRowTransform,
  PHASE8_TRANSFORMED_SQLITE_DATASETS,
} from '../tenant-backup-phase8-row-transform';
import { planPhase8InstalledSqliteResources } from '../tenant-backup-phase8-plan-loader';
import {
  ADMIN_ROLE_ASSIGNMENTS_DATASET,
  createTenantBackupRestoreAuthorityGuard,
  TENANT_SETTINGS_DOCUMENTS_DATASET,
} from '../tenant-backup-restore-authority';
import { TenantBackupRequestStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const sourcePiiKey = '11'.repeat(32);
const targetPiiKey = '22'.repeat(32);
const sourceRpKey = '33'.repeat(32);
const targetRpKey = '44'.repeat(32);
const sourceTenantKey = 'source-tenant-key';
const targetTenantKey = 'target-tenant-key';
const selection = {
  settings: true,
  users: true,
  admin: true,
  artifacts: true,
  logs: { audit: true, other: true, sensitive: true, period: 'all' as const },
};

type Family = 'core' | 'pii' | 'admin';

function renderSqliteMigration(sql: string): string {
  return sql
    .replaceAll(
      '__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__',
      "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))"
    )
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
}

function freshDatabase(family: Family) {
  const database = new DatabaseSync(':memory:');
  const directory = `${root}migrations/${family}/d1`;
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    database.exec(renderSqliteMigration(readFileSync(`${directory}/${file}`, 'utf8')));
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function schemaAdapter(database: SQLiteDatabase) {
  const values = (params: unknown[]) => params.map((value) => value as SQLInputValue);
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return database.prepare(sql).all(...values(params)) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      return (database.prepare(sql).get(...values(params)) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(database.prepare(sql).run(...values(params)).changes),
      };
    },
  };
}

/** An import request for tenant-a, stored where the restore reads it, with `authority`. */
async function importRequest(
  database: SQLiteDatabase,
  id: string,
  authority: {
    actorId: string;
    platformSettingsCategories: string[];
    globalAdmin: { permitted: boolean; hierarchyLevel: number };
  }
) {
  await new TenantBackupRequestStore(schemaAdapter(database)).create({
    id,
    tenantId: 'tenant-a',
    actorId: authority.actorId,
    idempotencyKey: id,
    intent: {
      version: 1,
      kind: 'import',
      source: { tenantId: 'tenant-a', issuer: 'https://issuer.example', productVersion: '0.4.2' },
      selection,
      inputs: [{ id: 'upload-a', digestSha256: 'aa'.repeat(32) }],
      authority,
    },
    now: 1,
  });
  return {
    lease: { tenantId: 'tenant-a', operationId: id, owner: 'worker', fencingToken: 1 },
  } as never;
}

async function phase8Plan() {
  const controller = new AbortController();
  const databases = (['core', 'core', 'pii', 'admin'] as const).map((family, index) => ({
    family,
    resourceId: `${family}-db-${index}`,
    database: freshDatabase(family),
  }));
  try {
    return await planPhase8InstalledSqliteResources(
      databases.map(({ family, resourceId, database }) => ({
        resourceId,
        family,
        database: schemaAdapter(database),
      })),
      controller.signal
    );
  } finally {
    for (const { database } of databases) database.close();
  }
}

function applySnapshot(
  database: SQLiteDatabase,
  planned: readonly PlannedInstalledSqliteDataset[]
) {
  database.exec(SQLITE_SNAPSHOT_SCHEMA);
  const captures = [
    ...new Map(planned.map((entry) => [entry.capture.table, entry.capture])).values(),
  ];
  for (const capture of captures) database.exec(sqliteSnapshotTriggers(capture, 'json'));
  const start = sqliteSnapshotStartStatement(
    captures,
    'phase8-snapshot',
    'tenant-a',
    sourceTenantKey,
    'json'
  );
  expect(database.prepare(start.sql).run(...start.params).changes).toBe(1);
}

async function* values<T>(items: readonly T[]) {
  yield* items;
}

describe('Phase 8 empty-environment SQL roundtrip', () => {
  it('roundtrips failure aggregates selected by last_at with their complete cumulative count', async () => {
    const planned = await phase8Plan();
    const entry = planned.find(({ dataset }) => dataset.id === 'admin.identity_mapping_failures');
    if (!entry) throw new Error('mapping_failure_dataset_missing');
    const source = freshDatabase('admin');
    const target = freshDatabase('admin');
    const boundaryUnixMs = 100 * 86_400_000;
    const lower = boundaryUnixMs - 7 * 86_400_000;
    const chosen = {
      settings: false,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: true, sensitive: false, period: 7 as const },
    };
    try {
      const insert = source.prepare(`INSERT INTO identity_mapping_failures
        (id,tenant_id,client_id,code,tier,set_id,first_at,last_at,count)
        VALUES (?,?,?,'set_missing',NULL,NULL,1,?,?)`);
      for (const [id, lastAt, count] of [
        ['a', lower - 1, 99],
        ['b', lower, 12345],
        ['c', boundaryUnixMs, 54321],
        ['d', boundaryUnixMs + 1, 12],
      ] as const)
        insert.run(id.repeat(64), 'tenant-a', `client-${id}`, lastAt, count);
      insert.run('e'.repeat(64), 'tenant-b', 'other-tenant-client', boundaryUnixMs, 999);
      applySnapshot(source, [entry]);
      // The export uses T0 even when this mutable tuple is incremented after capture.
      source
        .prepare('UPDATE identity_mapping_failures SET count=count+1,last_at=? WHERE id=?')
        .run(boundaryUnixMs + 2, 'b'.repeat(64));
      const filter = createPhase8TenantBackupRowFilter();
      const selectedRows: string[] = [];
      for (const other of [false, true]) {
        const datasets = selectInstalledSqliteDatasets(
          PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
          { ...chosen, logs: { ...chosen.logs, audit: !other, other } }
        );
        expect(datasets.some(({ id }) => id === entry.dataset.id)).toBe(other);
        if (!other) continue;
        const rows = source
          .prepare(sqliteSnapshotPageQuery(entry.capture, 'json'))
          .all('phase8-snapshot', 'tenant-a', '', 100) as Array<{ row_json: string | null }>;
        for (const { row_json: rowJson } of rows) {
          if (
            rowJson !== null &&
            (await filter({
              datasetId: entry.dataset.id,
              rowJson,
              boundaryUnixMs,
              selection: chosen,
            } as never))
          )
            selectedRows.push(rowJson);
        }
      }
      expect(selectedRows).toHaveLength(2);
      const policy = createPhase8SqliteInspectionPolicies(planned, {
        tenantKey: targetTenantKey,
        validateAdminEnvelope: async () => {},
        validatePhase8Envelope: async () => {},
        resolveAdminReference: async (_context, sourceAdminId) => sourceAdminId,
        resolvePluginReference: async (_context, sourceInstallationId) => sourceInstallationId,
        restoreHold: { write: async () => {}, verify: async () => {} },
      }).find(({ dataset }) => dataset.id === entry.dataset.id);
      if (!policy) throw new Error('mapping_failure_policy_missing');
      expect(policy.restoreHold).toBeUndefined();
      expect(PHASE8_TRANSFORMED_SQLITE_DATASETS).not.toContain(entry.dataset.id);
      for (const rowJson of selectedRows) {
        const row = JSON.parse(rowJson) as Record<string, readonly [string, string | null]>;
        expect(
          await policy.inspectRow(row, {
            module: 'logs',
            collection: entry.dataset.id,
            tenantId: 'tenant-a',
            id: String(row.id[1]),
          })
        ).toEqual([]);
        const restored = sqliteSnapshotRowInsert(entry.table, entry.capture.columns, rowJson);
        target.prepare(restored.sql).run(...restored.params);
      }
      expect(
        target
          .prepare('SELECT id,first_at,last_at,count FROM identity_mapping_failures ORDER BY id')
          .all()
      ).toEqual([
        { id: 'b'.repeat(64), first_at: 1, last_at: lower, count: 12345 },
        { id: 'c'.repeat(64), first_at: 1, last_at: boundaryUnixMs, count: 54321 },
      ]);
      expect(
        source.prepare('SELECT count FROM identity_mapping_failures WHERE id=?').get('b'.repeat(64))
      ).toEqual({ count: 12346 });
    } finally {
      source.close();
      target.close();
    }
  });

  it('rejects a shard whose installed schema cannot carry every family dataset', async () => {
    const coreA = freshDatabase('core');
    const coreB = freshDatabase('core');
    const pii = freshDatabase('pii');
    const admin = freshDatabase('admin');
    try {
      coreB.exec('PRAGMA foreign_keys = OFF; DROP TABLE users_core; PRAGMA foreign_keys = ON');
      await expect(
        planPhase8InstalledSqliteResources(
          [
            { resourceId: 'core-a', family: 'core', database: schemaAdapter(coreA) },
            { resourceId: 'core-b', family: 'core', database: schemaAdapter(coreB) },
            { resourceId: 'pii-a', family: 'pii', database: schemaAdapter(pii) },
            { resourceId: 'admin-a', family: 'admin', database: schemaAdapter(admin) },
          ],
          new AbortController().signal
        )
      ).rejects.toThrow('backup_phase8_installed_plan_invalid');
    } finally {
      coreA.close();
      coreB.close();
      pii.close();
      admin.close();
    }
  }, 20_000);

  // Full migrations on ten in-memory databases plus real bundle/password crypto can exceed
  // 20 seconds under CI coverage and parallel package load. Keep this budget local to the roundtrip.
  it('restores every SQL contract with reusable user authentication and mapped Admin access', async () => {
    const planned = await phase8Plan();
    const source = {
      core: freshDatabase('core'),
      pii: freshDatabase('pii'),
      admin: freshDatabase('admin'),
    };
    const target = {
      core: freshDatabase('core'),
      pii: freshDatabase('pii'),
      admin: freshDatabase('admin'),
    };
    try {
      const sourceUserPassword = 'phase8-existing-user-password';
      const sourceUserPasswordHash = await hashPassword(sourceUserPassword);
      const totp = await encryptValue('JBSWY3DPEHPK3PXP', sourcePiiKey, 'AES-256-GCM', 3);
      const access = await encryptUpstreamProviderSecret('access-token', sourceRpKey);
      const refresh = await encryptUpstreamProviderSecret('refresh-token', sourceRpKey);
      source.core.exec(`
        INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at)
        VALUES('tenant-a','TENANTA','${sourceTenantKey}','Tenant A',1,1);
        INSERT INTO users_core(
          id,tenant_id,email_verified,password_hash,is_active,user_type,pii_partition,pii_status,
          created_at,updated_at,status,lifecycle_state
        ) VALUES('user-a','tenant-a',1,'${sourceUserPasswordHash}',1,'end_user','default','active',1,1,'active','active');
        INSERT INTO identity_subjects(
          id,tenant_id,subject_type,lifecycle_state,display_label,created_at,updated_at
        ) VALUES('subject-a','tenant-a','human','active','User A',1,1);
        INSERT INTO identity_accounts(
          id,tenant_id,account_type,lifecycle_state,primary_subject_id,created_at,updated_at
        ) VALUES('account-a','tenant-a','human','active','subject-a',1,1);
        INSERT INTO totp_credentials(
          id,tenant_id,user_id,secret_encrypted,secret_key_version,status,created_at
        ) VALUES('totp-a','tenant-a','user-a','${totp.encrypted}',3,'active',1);
      `);
      source.pii.exec(`
        INSERT INTO users_pii(id,tenant_id,pii_class,email,created_at,updated_at)
        VALUES('user-a','tenant-a','IDENTITY_CORE','user@example.test',1,1);
        INSERT INTO linked_identities(
          id,tenant_id,user_id,provider_id,provider_user_id,linked_at,email_verified,
          access_token_encrypted,refresh_token_encrypted,provisioning_state
        ) VALUES(
          'link-a','tenant-a','user-a','provider-a','provider-user-a',1,1,
          '${access}','${refresh}','active'
        );
      `);
      source.admin.exec(`
        INSERT INTO admin_users(
          id,tenant_id,email,email_verified,name,password_hash,is_active,status,mfa_enabled,
          totp_secret_encrypted,last_login_ip,created_at,updated_at
        ) VALUES(
          'source-admin','tenant-a','source-admin@example.test',1,'Source Admin','source-password',
          1,'active',1,'source-totp','192.0.2.10',1,1
        );
        INSERT INTO admin_roles(
          id,tenant_id,name,display_name,permissions_json,hierarchy_level,role_type,is_system,
          created_at,updated_at
        ) VALUES(
          'role-a','tenant-a','tenant_operator','Tenant Operator','["admin:users:read"]',10,
          'custom',0,1,1
        );
        INSERT INTO admin_role_assignments(
          id,tenant_id,admin_user_id,admin_role_id,scope_type,assigned_by,created_at
        ) VALUES(
          'assignment-a','tenant-a','source-admin','role-a','tenant','source-admin',1
        );
        INSERT INTO admin_role_assignments(
          id,tenant_id,admin_user_id,admin_role_id,scope_type,scope_id,assigned_by,created_at
        ) VALUES(
          'assignment-global','tenant-a','source-admin','role_admin','global',NULL,'source-admin',1
        );
        INSERT INTO tenant_settings_documents(
          tenant_id,scope_type,scope_id,category,document_json,version,revision,projection_state,
          updated_at,projected_at
        ) VALUES(
          'tenant-a','tenant','tenant-a','institution',
          '{"institution.scopes":["other-university.example"]}',
          'sha256:${'a'.repeat(16)}',1,'applied',1,1
        );
        INSERT INTO identity_mapping_failures
          (id,tenant_id,client_id,code,tier,set_id,first_at,last_at,count)
        VALUES('${'f'.repeat(64)}','tenant-a','deleted-client','set_missing',
          'platform_default','deleted-set',1,1000,777);
      `);
      target.admin.exec(`
        INSERT INTO admin_users(
          id,tenant_id,email,email_verified,name,password_hash,is_active,status,created_at,updated_at
        ) VALUES(
          'target-admin','tenant-a','target-admin@example.test',1,'Target Admin','target-password',
          1,'active',1,1
        );
      `);

      for (const family of ['core', 'pii', 'admin'] as const)
        applySnapshot(
          source[family],
          planned.filter((entry) => entry.family === family)
        );
      const filter = createPhase8TenantBackupRowFilter();
      const transform = createPhase8TenantBackupRowTransform(
        { PII_ENCRYPTION_KEY: sourcePiiKey, RP_TOKEN_ENCRYPTION_KEY: sourceRpKey },
        {
          transformAdminEnvelope: vi.fn(async (_id, rowJson) => rowJson),
          loadExternalPiiLogValues: vi.fn(async () => null),
        }
      );
      const exported = new Map<string, string[]>();
      const tenantKeyDatasets = new Set<string>(PORTABLE_TENANT_KEY_SQLITE_DATASETS);
      expect(
        planned
          .filter((entry) => portableTenantKeyColumn(entry.capture) !== undefined)
          .map(({ dataset }) => dataset.id)
          .sort()
      ).toEqual([...PORTABLE_TENANT_KEY_SQLITE_DATASETS].sort());
      const boundaryUnixMs = 10_000_000;
      for (const entry of planned) {
        const rows = (
          source[entry.family as Family]
            .prepare(sqliteSnapshotPageQuery(entry.capture, 'json', entry.partitions))
            .all('phase8-snapshot', 'tenant-a', '', 10_000) as Array<Record<string, unknown>>
        )
          // A progress row (row_json NULL) only moves past other tenants' rows.
          .filter((row: Record<string, unknown>) => row.row_json !== null)
          .map((row: Record<string, unknown>) => String(row.row_json));
        const accepted: string[] = [];
        for (const rowJson of rows) {
          if (
            !(await filter({
              datasetId: entry.dataset.id,
              rowJson,
              boundaryUnixMs,
              selection,
            } as never))
          )
            continue;
          let portableRow = (PHASE8_TRANSFORMED_SQLITE_DATASETS as readonly string[]).includes(
            entry.dataset.id
          )
            ? await transform({
                datasetId: entry.dataset.id,
                rowJson,
                boundaryUnixMs,
                selection,
              } as never)
            : rowJson;
          if (tenantKeyDatasets.has(entry.dataset.id))
            portableRow = normalizePortableTenantKeyRow(
              entry.capture,
              portableRow,
              sourceTenantKey,
              (!('parent' in entry.capture) && entry.capture.tenantIdentity === 'tenantKey') ||
                entry.dataset.id === 'core.tenants'
            );
          accepted.push(portableRow);
        }
        exported.set(entry.dataset.id, accepted);
      }

      const datasets = planned.map((entry) => entry.dataset);
      const key = await createTenantBundleKeyEnvelope('phase8-roundtrip-password');
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
          snapshotId: 'phase8-snapshot',
          boundaryUnixMs,
          inventoryDigestSha256: 'ab'.repeat(32),
          datasets,
        },
        values(
          datasets.map((dataset) => ({
            datasetId: dataset.id,
            chunks: values(
              (exported.get(dataset.id) ?? []).map((row) => new TextEncoder().encode(row))
            ),
          }))
        ),
        key,
        expected
      ))
        artifact.push(bytes);
      expect(
        new TextDecoder().decode(Uint8Array.from(artifact.flatMap((part) => [...part])))
      ).not.toContain('JBSWY3DPEHPK3PXP');

      for (const database of Object.values(source)) database.close();
      const restored = new Map(datasets.map((dataset) => [dataset.id, [] as string[]]));
      const restoredKey = await unlockTenantBundleKeyEnvelope(
        envelope,
        'phase8-roundtrip-password'
      );
      for await (const event of decodeTenantBundle(values(artifact), restoredKey, expected, {
        maxTotalBytes: 32 * 1024 * 1024,
        maxFrames: 16_384,
      })) {
        if (event.kind === 'chunk')
          restored
            .get(event.datasetId)
            ?.push(
              new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
                .decode(event.bytes)
                .trimEnd()
            );
      }

      const policies = createPhase8SqliteInspectionPolicies(planned, {
        tenantKey: targetTenantKey,
        validateAdminEnvelope: async () => {},
        async validatePhase8Envelope(datasetId, row) {
          if (datasetId === 'core.totp_credentials') portableTotpSecret(row);
          if (datasetId === 'pii.linked_identities') portableLinkedIdentityTokens(row);
        },
        resolveAdminReference: async (_context, sourceAdminId) => {
          if (sourceAdminId !== 'source-admin') throw new Error('unexpected_admin');
          return 'target-admin';
        },
        resolvePluginReference: async (_context, sourceInstallationId) => sourceInstallationId,
        restoreHold: { write: async () => {}, verify: async () => {} },
      });
      // The rows that grant more than a tenant: refused for a tenant-only requester, as decoded
      // from the bundle, before anything is written.
      const guard = createTenantBackupRestoreAuthorityGuard({
        database: schemaAdapter(target.admin),
        loadBundleRoles: async () => restored.get('admin.admin_roles') ?? [],
      });
      const tenantOnly = await importRequest(target.admin, 'tenant-only-import', {
        actorId: 'tenant-admin',
        platformSettingsCategories: [],
        globalAdmin: { permitted: false, hierarchyLevel: 0 },
      });
      const guarded = new Map(guard.wrap(policies).map((policy) => [policy.dataset.id, policy]));
      const refusedRows = [
        ...restored
          .get(TENANT_SETTINGS_DOCUMENTS_DATASET)!
          .filter((row) => JSON.parse(row).category[1] === 'institution')
          .map((row) => [TENANT_SETTINGS_DOCUMENTS_DATASET, row] as const),
        ...restored
          .get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!
          .filter((row) => JSON.parse(row).scope_type[1] === 'global')
          .map((row) => [ADMIN_ROLE_ASSIGNMENTS_DATASET, row] as const),
      ];
      expect(refusedRows).toHaveLength(2);
      for (const [datasetId, row] of refusedRows)
        await expect(guarded.get(datasetId)!.admitRow!.admit(tenantOnly, row)).rejects.toThrow(
          'backup_restore_authority_required'
        );
      // A platform operator's DR restore keeps them (the restore below runs as that request).
      const platformRestore = await importRequest(target.admin, 'platform-import', {
        actorId: 'platform-admin',
        platformSettingsCategories: ['institution'],
        globalAdmin: { permitted: true, hierarchyLevel: 100 },
      });
      for (const [datasetId, row] of refusedRows)
        await guarded.get(datasetId)!.admitRow!.admit(platformRestore, row);
      const byId = new Map(
        [...guarded.values()].map((policy) => [policy.dataset.id, policy] as const)
      );
      for (const entry of planned.filter(({ dataset }) => tenantKeyDatasets.has(dataset.id))) {
        const policy = byId.get(entry.dataset.id)!;
        const column = portableTenantKeyColumn(entry.capture)!;
        expect(
          policy.restoreIdentityOverrides?.[column] ?? policy.restoreOverrides?.[column],
          entry.dataset.id
        ).toEqual(['text', targetTenantKey]);
        if (!('parent' in entry.capture) && entry.capture.tenantIdentity === 'tenantKey') {
          expect(policy.tenantKey, entry.dataset.id).toBe(PORTABLE_TENANT_KEY);
          expect(policy.restoreTenantKey, entry.dataset.id).toBe(targetTenantKey);
        }
      }
      const ordered: typeof policies = [];
      const visited = new Set<string>();
      const visit = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        const policy = byId.get(id);
        if (!policy) throw new Error(`missing_policy:${id}`);
        for (const dependency of policy.restoreAfter ?? []) visit(dependency);
        ordered.push(policy);
      };
      for (const id of byId.keys()) visit(id);
      const restoreContext = platformRestore;
      for (const policy of ordered) {
        if (policy.restoreDisposition === 'reference_only') continue;
        const entry = planned.find((candidate) => candidate.dataset.id === policy.dataset.id)!;
        for (let rowJson of restored.get(policy.dataset.id) ?? []) {
          if (
            policy.restoreHold &&
            (await policy.restoreHold.shouldHold(restoreContext, rowJson))
          ) {
            await policy.restoreHold.write(restoreContext, rowJson);
            continue;
          }
          if (policy.restoreTransform)
            rowJson = await policy.restoreTransform.transform(restoreContext, rowJson, 'write');
          const fields = JSON.parse(rowJson) as Record<string, readonly [string, string | null]>;
          for (const [column, override] of Object.entries(policy.restoreOverrides ?? {}))
            fields[column] = override;
          for (const [column, override] of Object.entries(policy.restoreIdentityOverrides ?? {}))
            fields[column] = override;
          const insert = sqliteSnapshotRowInsert(
            entry.capture.table,
            entry.capture.columns,
            JSON.stringify(fields)
          );
          target[entry.family as Family].prepare(insert.sql).run(...insert.params);
        }
      }

      const portableTotp = portableTotpSecret(
        JSON.parse(restored.get('core.totp_credentials')![0])
      );
      const targetTotp = await encryptValue(portableTotp.plaintext, targetPiiKey, 'AES-256-GCM', 7);
      target.core
        .prepare(
          `UPDATE totp_credentials SET secret_encrypted=?,secret_key_version=7
           WHERE tenant_id='tenant-a' AND id='totp-a'`
        )
        .run(targetTotp.encrypted);
      const portableTokens = portableLinkedIdentityTokens(
        JSON.parse(restored.get('pii.linked_identities')![0])
      );
      target.pii
        .prepare(
          `UPDATE linked_identities SET access_token_encrypted=?,refresh_token_encrypted=?
           WHERE tenant_id='tenant-a' AND id='link-a'`
        )
        .run(
          await encryptUpstreamProviderSecret(portableTokens.accessToken!, targetRpKey),
          await encryptUpstreamProviderSecret(portableTokens.refreshToken!, targetRpKey)
        );

      expect(planned).toHaveLength(PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.length);
      expect(planned.find(({ dataset }) => dataset.id === 'core.users_core')?.sources).toHaveLength(
        2
      );
      expect(planned.find(({ dataset }) => dataset.id === 'pii.users_pii')?.sources).toHaveLength(
        1
      );
      expect(restored.size).toBe(PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.length);
      expect(
        target.admin
          .prepare(
            'SELECT client_id,code,tier,set_id,first_at,last_at,count FROM identity_mapping_failures'
          )
          .get()
      ).toEqual({
        client_id: 'deleted-client',
        code: 'set_missing',
        tier: 'platform_default',
        set_id: 'deleted-set',
        first_at: 1,
        last_at: 1000,
        count: 777,
      });
      expect(JSON.parse(restored.get('core.tenants')![0]).tenant_key).toEqual([
        'text',
        PORTABLE_TENANT_KEY,
      ]);
      expect(
        target.core.prepare("SELECT tenant_key FROM tenants WHERE id='tenant-a'").get()
      ).toEqual({ tenant_key: targetTenantKey });
      const targetUser = target.core
        .prepare("SELECT password_hash FROM users_core WHERE id='user-a'")
        .get() as { password_hash: string };
      expect(targetUser.password_hash).toBe(sourceUserPasswordHash);
      expect(await verifyPassword(sourceUserPassword, targetUser.password_hash)).toBe(true);
      expect(await verifyPassword('wrong-password', targetUser.password_hash)).toBe(false);
      const targetTotpRow = target.core
        .prepare(
          "SELECT secret_encrypted,secret_key_version FROM totp_credentials WHERE id='totp-a'"
        )
        .get() as { secret_encrypted: string; secret_key_version: number };
      expect((await decryptValue(targetTotpRow.secret_encrypted, targetPiiKey)).decrypted).toBe(
        'JBSWY3DPEHPK3PXP'
      );
      expect(targetTotpRow.secret_key_version).toBe(7);
      const targetTokens = target.pii
        .prepare(
          "SELECT access_token_encrypted,refresh_token_encrypted FROM linked_identities WHERE id='link-a'"
        )
        .get() as { access_token_encrypted: string; refresh_token_encrypted: string };
      expect(
        await decryptUpstreamProviderSecret(targetTokens.access_token_encrypted, targetRpKey)
      ).toBe('access-token');
      expect(
        await decryptUpstreamProviderSecret(targetTokens.refresh_token_encrypted, targetRpKey)
      ).toBe('refresh-token');
      expect(
        target.admin.prepare("SELECT count(*) total FROM admin_users WHERE id='source-admin'").get()
      ).toEqual({ total: 0 });
      expect(
        target.admin
          .prepare(
            "SELECT admin_user_id,admin_role_id FROM admin_role_assignments WHERE id='assignment-a'"
          )
          .get()
      ).toEqual({
        admin_user_id: 'target-admin',
        admin_role_id: 'role-a',
      });
      expect(
        target.admin.prepare("SELECT password_hash FROM admin_users WHERE id='target-admin'").get()
      ).toEqual({ password_hash: 'target-password' });
      expect(
        target.admin
          .prepare(
            "SELECT document_json FROM tenant_settings_documents WHERE category='institution'"
          )
          .get()
      ).toEqual({ document_json: '{"institution.scopes":["other-university.example"]}' });
      expect(
        target.admin
          .prepare(
            "SELECT admin_user_id,scope_type FROM admin_role_assignments WHERE id='assignment-global'"
          )
          .get()
      ).toEqual({ admin_user_id: 'target-admin', scope_type: 'global' });
      for (const database of Object.values(target))
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      for (const database of [...Object.values(source), ...Object.values(target)]) {
        try {
          database.close();
        } catch {
          // Source databases are deliberately closed before bundle decode.
        }
      }
    }
  }, 60_000);
});
