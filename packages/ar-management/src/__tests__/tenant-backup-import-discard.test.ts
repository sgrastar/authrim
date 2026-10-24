// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { generateVersion, type Env } from '@authrim/ar-lib-core';
import { TenantBackupOperationStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-store';
import { runTenantBackupScheduler } from '@authrim/ar-lib-core/services/tenant-portability/operation-scheduler';
import {
  runTenantBackupOperationCleanupStep,
  type TenantBackupOperationCleanupAdapter,
} from '@authrim/ar-lib-core/services/tenant-portability/operation-cleanup';
import { cleanupTenantBackupRestoreTargetPage } from '@authrim/ar-lib-core/services/tenant-portability/restore-target-cleanup';
import { SqliteRestoreTarget } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-restore-target';
import { createPhase8SqliteInspectionPolicies } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-references';
import { plannedInstalledSqliteDatasetSources } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import {
  planTenantDiscard,
  TENANT_DISCARD_UNPLANNED_TABLES,
} from '@authrim/ar-lib-core/services/tenant-portability/restore-target-discard';
import { TENANT_DATASET_POLICIES } from '@authrim/ar-lib-core/services/tenant-portability/dataset-registry';
import type { BackupSchemaTable } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-schema-types';
import { planPhase8InstalledSqliteResources } from '../tenant-backup-phase8-plan-loader';
import {
  createTenantBackupImportDiscard,
  TENANT_BACKUP_IMPORT_DISCARD_LEASE_WAIT_MS,
  TENANT_BACKUP_IMPORT_DISCARD_PROJECTION_WAIT_MS,
} from '../tenant-backup-import-discard';

const admin = vi.hoisted(() => ({ adapter: null as unknown }));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  requireDedicatedAdminDatabaseAdapter: () => admin.adapter,
}));

const root = fileURLToPath(new URL('../../../../', import.meta.url));
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

export function freshDatabase(family: Family) {
  const database = new DatabaseSync(':memory:');
  const directory = `${root}migrations/${family}/d1`;
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    database.exec(renderSqliteMigration(readFileSync(`${directory}/${file}`, 'utf8')));
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

export function adapter(database: DatabaseSync) {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return database.prepare(sql).all(...params) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      return (database.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return { success: true, rowsAffected: Number(database.prepare(sql).run(...params).changes) };
    },
  };
}

export async function realDiscardPlans(databases: Record<Family, DatabaseSync>) {
  const schemas = new Map<string, readonly BackupSchemaTable[]>();
  const resources = (Object.keys(databases) as Family[]).map((family) => ({
    resourceId: `${family}-db`,
    family,
    database: adapter(databases[family]),
  }));
  const planned = await planPhase8InstalledSqliteResources(
    resources,
    new AbortController().signal,
    (resourceId, tables) => schemas.set(resourceId, tables)
  );
  const policies = new Map(
    createPhase8SqliteInspectionPolicies(planned, {
      tenantKey: 'target-key',
      validateAdminEnvelope: async () => {},
      validatePhase8Envelope: async () => {},
      resolveAdminReference: async () => 'unused',
      resolvePluginReference: async () => 'unused',
      restoreHold: { write: async () => {}, verify: async () => {} },
    }).map((policy) => [policy.dataset.id, policy])
  );
  return new Map(
    resources.map((resource) => [
      resource.family,
      planTenantDiscard({
        family: resource.family,
        schema: schemas.get(resource.resourceId)!,
        identity: { tenantId: 'tenant-a', tenantKey: 'target-key' },
        datasets: planned
          .filter((entry) =>
            plannedInstalledSqliteDatasetSources(entry).some(
              ({ resourceId }) => resourceId === resource.resourceId
            )
          )
          .map((entry) => {
            const policy = policies.get(entry.dataset.id)!;
            return {
              id: entry.dataset.id,
              kind: entry.dataset.kind,
              capture: entry.capture,
              tenantKey: policy.restoreTenantKey,
              referenceOnly: policy.restoreDisposition === 'reference_only',
              deferredColumns: policy.deferredColumns ?? [],
            };
          }),
      }),
    ])
  );
}

describe('tenant restore discard plan on the installed schema', () => {
  it('classifies every core and PII table outside the installed datasets', () => {
    for (const family of ['core', 'pii'] as const) {
      const unplanned = Object.keys(TENANT_DISCARD_UNPLANNED_TABLES[family] ?? {}).sort();
      const registry = TENANT_DATASET_POLICIES.filter(
        (policy) =>
          policy.family === family && ['rebuild', 'ephemeral', 'external'].includes(policy.kind)
      )
        .map(({ table }) => table)
        .sort();
      expect(unplanned, family).toEqual(registry);
    }
  });

  it('plans every family within D1 statement limits and keeps tenants, logs and catalogs', async () => {
    const databases = {
      core: freshDatabase('core'),
      pii: freshDatabase('pii'),
      admin: freshDatabase('admin'),
    };
    try {
      const plans = await realDiscardPlans(databases);
      const tables = (family: Family) => plans.get(family)!.tables.map(({ table }) => table);
      expect(tables('core')).not.toContain('tenants');
      expect(tables('core')).not.toContain('audit_log');
      expect(tables('core')).not.toContain('consent_history');
      expect(tables('core')).not.toContain('object_catalog');
      expect(tables('core')).toContain('users_core');
      expect(tables('core')).toContain('sessions');
      expect(tables('core')).toContain('service_group_inputs');
      expect(tables('admin')).not.toContain('admin_audit_log');
      expect(tables('admin')).not.toContain('admin_users');
      expect(tables('admin')).not.toContain('tenant_backup_operations');
      expect(tables('admin')).toContain('tenant_settings_documents');
      expect(tables('admin')).toContain('field_catalogs');
      expect(tables('pii')).toContain('users_pii');
      expect(tables('pii')).not.toContain('pii_log');
      // Children (by foreign key or by ownership) come before their parents.
      const core = tables('core');
      expect(core.indexOf('sessions')).toBeLessThan(core.indexOf('users_core'));
      const admin = tables('admin');
      expect(admin.indexOf('field_catalog_versions')).toBeLessThan(admin.indexOf('field_catalogs'));
      expect(admin.indexOf('logging_key_versions')).toBeLessThan(
        admin.indexOf('logging_key_registry')
      );
    } finally {
      for (const database of Object.values(databases)) database.close();
    }
  }, 60_000);
});

const OPERATION = 'import-op';
const digest = (char: string) => char.repeat(64);

function kv() {
  const values = new Map<string, string>();
  const emptyPages = { value: 0 };
  return {
    values,
    emptyPages,
    binding: {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
      async list({
        prefix,
        limit = 1000,
        cursor,
      }: {
        prefix: string;
        limit?: number;
        cursor?: string;
      }) {
        // A listing may first return empty pages that are not the last one (deleted keys). They
        // depend on the cursor alone, so a sweep that forgets its cursor reads them again.
        const position = cursor?.startsWith('empty-') ? Number(cursor.slice(6)) : 0;
        if (position < emptyPages.value)
          return { keys: [], list_complete: false, cursor: `empty-${position + 1}` };
        const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).sort();
        return {
          keys: keys.slice(0, limit).map((name) => ({ name })),
          list_complete: keys.length <= limit,
          cursor: 'next',
        };
      },
    },
  };
}

/** Every row of every table whose tenant_id names the given tenant, plus its tenant row. */
function tenantRows(database: DatabaseSync, tenantId: string) {
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'")
    .all() as { name: string }[];
  const rows: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const columns = (
      database.prepare(`SELECT name FROM pragma_table_info('${name}')`).all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    const filter = columns.includes('tenant_id')
      ? 'tenant_id=?'
      : name === 'tenants'
        ? 'id=?'
        : null;
    if (!filter) continue;
    const found = database
      .prepare(`SELECT * FROM "${name}" WHERE ${filter} ORDER BY rowid`)
      .all(tenantId);
    if (found.length) rows[name] = found;
  }
  return rows;
}

async function environment(
  options: {
    written?: boolean;
    legalHold?: boolean;
    bundleHolds?: number;
    /** Client settings documents in the Admin database. */
    clients?: number;
    /** Their KV keys; one per document unless given. */
    clientKeys?: number;
    /** The import's restore step; by default the operation is only ever cleaned up. */
    run?: () => Promise<never>;
  } = {}
) {
  const databases = {
    core: freshDatabase('core'),
    pii: freshDatabase('pii'),
    admin: freshDatabase('admin'),
  };
  const { core, pii } = databases;
  const adminDb = databases.admin;
  admin.adapter = adapter(adminDb);
  const now = { value: 10_000_000 };
  for (const [tenant, state] of [
    ['tenant-a', 'provisioning'],
    ['tenant-b', 'active'],
  ] as const)
    core
      .prepare(
        `INSERT INTO tenants(id,tenant_code,tenant_key,name,lifecycle_state,created_at,updated_at)
        VALUES (?,?,?,?,?,1,1)`
      )
      .run(tenant, tenant.toUpperCase().replace('-', ''), `${tenant}-key`, tenant, state);
  for (const [tenant, user] of [
    ['tenant-a', 'user-a'],
    ['tenant-a', 'user-a2'],
    ['tenant-b', 'user-b'],
  ])
    core
      .prepare('INSERT INTO users_core(id,tenant_id,created_at,updated_at) VALUES (?,?,1,1)')
      .run(user, tenant);
  core.exec(`
    INSERT INTO sessions(id,user_id,tenant_id,expires_at,created_at) VALUES
      ('session-a','user-a','tenant-a',9,1),('session-b','user-b','tenant-b',9,1);
    INSERT INTO consent_history(id,tenant_id,user_id,client_id,action,created_at) VALUES
      ('consent-a','tenant-a','user-a','client','granted',1),
      ('consent-b','tenant-b','user-b','client','granted',1);
    INSERT INTO roles(id,tenant_id,name,permissions_json,created_at) VALUES
      ('role-parent','tenant-a','parent','[]',1),('role-b','tenant-b','b','[]',1);
    INSERT INTO roles(id,tenant_id,name,permissions_json,parent_role_id,created_at) VALUES
      ('role-child','tenant-a','child','[]','role-parent',1);
    INSERT INTO audit_log(id,tenant_id,action,created_at) VALUES
      ('audit-a','tenant-a','restored.history',1),('audit-b','tenant-b','b.history',1);
  `);
  pii.exec(`
    INSERT INTO users_pii(id,tenant_id,email,created_at,updated_at) VALUES
      ('user-a','tenant-a','a@example.test',1,1),('user-b','tenant-b','b@example.test',1,1);
  `);
  adminDb.exec(`
    INSERT INTO admin_audit_log(id,tenant_id,action,result,created_at) VALUES
      ('request-a','tenant-a','tenant_backup.import_requested','success',1),
      ('approval-a','tenant-a','tenant_backup.restore_approved','success',2),
      ('cancel-a','tenant-a','tenant_backup.cancel_requested','success',3),
      ('audit-admin-b','tenant-b','b.action','success',1);
  `);
  for (const tenant of ['tenant-a', 'tenant-b'])
    adminDb
      .prepare(
        `INSERT INTO tenant_settings_documents
        (tenant_id,scope_type,scope_id,category,document_json,version,revision,projection_state,updated_at)
        VALUES (?,'tenant',?,'security','{}',?,1,'pending',1)`
      )
      .run(tenant, tenant, generateVersion({}));
  for (let index = 0; index < (options.clients ?? 0); index++) {
    const client = `client-${String(index).padStart(4, '0')}-${'x'.repeat(30)}`;
    adminDb
      .prepare(
        `INSERT INTO tenant_settings_documents
        (tenant_id,scope_type,scope_id,category,document_json,version,revision,projection_state,updated_at)
        VALUES ('tenant-a','client',?,'oauth','{}',?,1,'pending',1)`
      )
      .run(client, generateVersion({}));
  }
  if (options.legalHold)
    core.exec(`
      INSERT INTO identity_subjects(id,tenant_id,subject_type,lifecycle_state,display_label,created_at,updated_at)
      VALUES ('subject-a','tenant-a','human','active','A',1,1);
      INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,primary_subject_id,created_at,updated_at)
      VALUES ('account-a','tenant-a','human','active','subject-a',1,1);
    `);
  if (options.legalHold)
    core
      .prepare(
        `INSERT INTO legal_holds(id,tenant_id,subject_type,subject_id,reason_code,created_by,created_at,updated_at)
        VALUES ('hold-a','tenant-a','account','account-a','litigation','admin',1,1)`
      )
      .run();

  const store = new TenantBackupOperationStore(admin.adapter as never);
  await store.create({
    id: OPERATION,
    tenantId: 'tenant-a',
    kind: 'import',
    idempotencyKey: 'import',
    requestDigest: digest('d'),
    actorId: 'admin',
    now: now.value,
  });
  const claimed = (await store.claim('tenant-a', OPERATION, 'restore-worker', now.value))!;
  const lease = {
    tenantId: 'tenant-a',
    operationId: OPERATION,
    owner: 'restore-worker',
    fencingToken: claimed.fencing_token,
  };
  const applying = (await store.checkpoint(
    lease,
    claimed.revision,
    'apply_sqlite_dataset',
    null,
    now.value
  ))!;
  // The sealed restore plan: one target per written database and the restore sequence.
  adminDb
    .prepare(
      `INSERT INTO tenant_backup_restore_plan_inventories
      (operation_id,tenant_id,input_inventory_digest,state,item_count,chain_digest,created_at)
      VALUES (?,?,?,'building',0,?,1)`
    )
    .run(OPERATION, 'tenant-a', digest('1'), digest('0'));
  const items = [
    ...['admin-db', 'core-db'].map((resourceId) => ({
      id: `restore-target:${OPERATION}:${resourceId}`,
      payload: {
        version: 1,
        kind: 'sqlite-restore-target',
        targetId: `${OPERATION}:${resourceId}`,
        resourceId,
        provisioningId: `setup:1:${resourceId}`,
        seedFingerprint: digest('3'),
      },
    })),
    {
      id: 'sqlite-restore-sequence',
      payload: {
        version: 2,
        kind: 'sqlite-restore-sequence',
        jobs: options.bundleHolds
          ? [
              {
                targetId: `${OPERATION}:core-db`,
                targetOrdinal: 1,
                datasetId: 'core.legal_holds',
                bundleId: 'a'.repeat(32),
                table: 'legal_holds',
                manifestDigest: digest('4'),
                policyDigest: digest('5'),
                recordCount: options.bundleHolds,
                byteCount: 10,
                reconcilesGeneratedRows: false,
              },
            ]
          : [],
      },
    },
  ];
  items.forEach((item, ordinal) => {
    adminDb
      .prepare(
        `INSERT INTO tenant_backup_restore_plan_inventory_items
        (operation_id,tenant_id,ordinal,item_id,payload_json,chain_digest,payload_digest)
        VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        OPERATION,
        'tenant-a',
        ordinal,
        item.id,
        JSON.stringify(item.payload),
        digest('6'),
        digest('7')
      );
  });
  adminDb
    .prepare(
      "UPDATE tenant_backup_restore_plan_inventories SET state='sealed',chain_digest=? WHERE operation_id=?"
    )
    .run(digest('2'), OPERATION);
  if (options.written !== false)
    for (const [database, resourceId] of [
      [adminDb, 'admin-db'],
      [core, 'core-db'],
    ] as const)
      database
        .prepare(
          `INSERT INTO tenant_backup_restore_targets
          (id,tenant_id,operation_id,resource_id,plan_digest,seed_fingerprint,owner,fencing_token,lease_expires_at,state)
          VALUES (?,?,?,?,?,?,'restore-worker',?,?,'loading')`
        )
        .run(
          `${OPERATION}:${resourceId}`,
          'tenant-a',
          OPERATION,
          resourceId,
          digest('2'),
          digest('3'),
          claimed.fencing_token,
          applying.lease_expires_at
        );

  const settings = kv();
  const config = kv();
  /** Observes each read of the core schema definitions within one cleanup lease. */
  const coreSchemaReads: {
    onRead?: (read: number) => void;
    onPage?: (sql: string, when: 'before' | 'after') => void;
  } = {};
  settings.values.set('settings:tenant:tenant-a:security', '{}');
  for (let index = 0; index < (options.clientKeys ?? options.clients ?? 0); index++)
    settings.values.set(
      `settings:client:tenant-a:client-${String(index).padStart(4, '0')}-${'x'.repeat(30)}:oauth`,
      '{}'
    );
  settings.values.set('settings:tenant:tenant-b:security', '{}');
  const discard = createTenantBackupImportDiscard({
    env: { SETTINGS: settings.binding, AUTHRIM_CONFIG: config.binding } as unknown as Env,
    tenantKey: 'tenant-a-key',
    platform: adapter(core),
    resolveCoreDefault: async () => adapter(core),
    now: () => now.value,
    resolveResources: async () => {
      const coreAdapter = adapter(core);
      const query = coreAdapter.query;
      coreAdapter.query = async <T>(sql: string, params: unknown[] = []) => {
        coreSchemaReads.onPage?.(sql, 'before');
        const rows = await query<T>(sql, params);
        coreSchemaReads.onPage?.(sql, 'after');
        return rows;
      };
      const queryOne = coreAdapter.queryOne;
      let definitionReads = 0;
      coreAdapter.queryOne = async <T>(sql: string, params: unknown[] = []) => {
        if (sql.includes("'name',name,'type',type,'table',tbl_name"))
          coreSchemaReads.onRead?.(++definitionReads);
        return queryOne<T>(sql, params);
      };
      return [
        { resourceId: 'admin-db', family: 'admin', database: adapter(adminDb) },
        { resourceId: 'core-db', family: 'core', database: coreAdapter },
        { resourceId: 'pii-db', family: 'pii', database: adapter(pii) },
      ];
    },
  });
  const cleanup: TenantBackupOperationCleanupAdapter = {
    async abortBoundary() {
      throw new Error('unexpected');
    },
    async resolveSnapshotSource() {
      throw new Error('unexpected');
    },
    prepareImportCleanup: (context) => discard.prepare(context),
    cleanupStagingPage: (context) =>
      cleanupTenantBackupRestoreTargetPage({
        database: admin.adapter as never,
        context,
        cleanup: (target) => discard.cleanupTarget(context, target),
        now: () => now.value,
      }),
    cleanupAdditionalPage: (context) => discard.cleanupAdditional(context),
    assertClean: (context) => discard.assertClean(context),
  };
  const tick = () =>
    runTenantBackupScheduler(
      admin.adapter as never,
      {
        run:
          options.run ??
          (async () => {
            throw new Error('unexpected run');
          }),
        cleanup: (context) =>
          runTenantBackupOperationCleanupStep({
            database: admin.adapter as never,
            context,
            adapter: cleanup,
            now: () => now.value,
          }),
      },
      new AbortController().signal,
      () => now.value,
      ['import'],
      8
    );
  /** Run ticks a minute apart until the operation ends or stops on a failure code. */
  const drive = async (limit = 40) => {
    const codes = new Set<string>();
    for (let i = 0; i < limit; i++) {
      now.value += 60_000;
      const result = await tick();
      for (const code of result.failureCodes) codes.add(code);
      const current = await store.get('tenant-a', OPERATION);
      if (current && ['cancelled', 'failed'].includes(current.state)) break;
    }
    return { operation: await store.get('tenant-a', OPERATION), codes: [...codes] };
  };
  const tenantB = () => ({
    core: tenantRows(core, 'tenant-b'),
    pii: tenantRows(pii, 'tenant-b'),
    admin: tenantRows(adminDb, 'tenant-b'),
  });
  return {
    databases,
    now,
    store,
    lease,
    applying,
    settings,
    drive,
    tenantB,
    coreSchemaReads,
    close: () => Object.values(databases).forEach((database) => database.close()),
  };
}

const count = (database: DatabaseSync, sql: string) =>
  Number((database.prepare(sql).get() as { n: number }).n);

describe('tenant restore discard after a partially written import', () => {
  it('discards the restored tenant on cancel, keeps audit rows and leaves tenant b untouched', async () => {
    const env = await environment();
    const { core, pii, admin: adminDb } = env.databases;
    try {
      const before = env.tenantB();
      expect(await env.store.requestCancel('tenant-a', OPERATION, env.now.value)).toMatchObject({
        state: 'cancelling',
      });
      const { operation, codes } = await env.drive();
      expect(codes).toEqual([]);
      expect(operation).toMatchObject({ state: 'cancelled', failure_reason: null });

      for (const table of ['users_core', 'sessions', 'roles', 'service_group_inputs'])
        expect(
          count(core, `SELECT count(*) AS n FROM ${table} WHERE tenant_id='tenant-a'`),
          table
        ).toBe(0);
      expect(count(pii, "SELECT count(*) AS n FROM users_pii WHERE tenant_id='tenant-a'")).toBe(0);
      expect(
        count(
          adminDb,
          "SELECT count(*) AS n FROM tenant_settings_documents WHERE tenant_id='tenant-a'"
        )
      ).toBe(0);
      // The tenant row stays and is marked deleted; audit and log rows stay.
      expect(core.prepare("SELECT lifecycle_state FROM tenants WHERE id='tenant-a'").get()).toEqual(
        {
          lifecycle_state: 'deleted',
        }
      );
      expect(
        adminDb
          .prepare("SELECT id FROM admin_audit_log WHERE tenant_id='tenant-a' ORDER BY id")
          .all()
          .map((row: { id: string }) => row.id)
      ).toEqual(['approval-a', 'cancel-a', 'request-a']);
      expect(count(core, "SELECT count(*) AS n FROM audit_log WHERE id='audit-a'")).toBe(1);
      // Kept history tied to a discarded user follows its ON DELETE CASCADE.
      expect(count(core, "SELECT count(*) AS n FROM consent_history WHERE id='consent-a'")).toBe(0);
      // Restore receipts are fenced and kept.
      expect(core.prepare('SELECT state FROM tenant_backup_restore_targets').all()).toEqual([
        { state: 'invalid' },
      ]);
      expect(env.settings.values.has('settings:tenant:tenant-a:security')).toBe(false);
      expect(env.settings.values.has('settings:tenant:tenant-b:security')).toBe(true);
      expect(env.tenantB()).toEqual(before);
    } finally {
      env.close();
    }
  }, 120_000);

  it('finishes a permanent failure while applying SQL rows as failed after the same discard', async () => {
    const env = await environment();
    const { core } = env.databases;
    try {
      const before = env.tenantB();
      expect(
        await env.store.failPermanently(
          env.lease,
          env.applying.revision,
          'backup_sqlite_row_too_large',
          env.now.value
        )
      ).toMatchObject({ state: 'cancelling' });
      const { operation } = await env.drive();
      expect(operation).toMatchObject({
        state: 'failed',
        failure_reason: 'backup_sqlite_row_too_large',
      });
      expect(count(core, "SELECT count(*) AS n FROM users_core WHERE tenant_id='tenant-a'")).toBe(
        0
      );
      expect(env.tenantB()).toEqual(before);
    } finally {
      env.close();
    }
  }, 120_000);

  it('discards an import whose restore refused a row its requester may not restore', async () => {
    const env = await environment({
      // As the restore step throws it for a refused row (restore-sqlite-step keeps the code).
      run: async () => {
        throw new Error('backup_restore_authority_required');
      },
    });
    const { admin: adminDb } = env.databases;
    // Rows the restore wrote before the refusal, beside the platform's own global assignment.
    adminDb.exec(`
      INSERT INTO admin_users(id,tenant_id,email,name,password_hash,is_active,status,created_at,updated_at)
      VALUES ('restored-admin','tenant-a','restored@example.test','Restored','x',1,'active',1,1),
        ('platform-admin','default','platform@example.test','Platform','x',1,'active',1,1);
      INSERT INTO admin_role_assignments(id,tenant_id,admin_user_id,admin_role_id,scope_type,scope_id,assigned_by,created_at)
      VALUES ('restored-assignment','tenant-a','restored-admin','role_admin','tenant','tenant-a','x',1),
        ('platform-assignment','default','platform-admin','role_super_admin','global',NULL,'setup',1);
    `);
    try {
      await env.store.release(env.lease, env.applying.revision, 'queued', env.now.value);
      // The step keeps failing on the same row: retries end with the import waiting.
      const failed = await env.drive(12);
      expect(failed.codes).toEqual(['backup_restore_authority_required']);
      expect(failed.operation).toMatchObject({
        state: 'waiting',
        phase: 'apply_sqlite_dataset',
      });
      expect(await env.store.requestCancel('tenant-a', OPERATION, env.now.value)).toMatchObject({
        state: 'cancelling',
      });
      const { operation } = await env.drive();
      expect(operation).toMatchObject({ state: 'cancelled' });
      for (const sql of [
        "SELECT count(*) AS n FROM tenant_settings_documents WHERE tenant_id='tenant-a'",
        "SELECT count(*) AS n FROM admin_role_assignments WHERE tenant_id='tenant-a'",
      ])
        expect(count(adminDb, sql), sql).toBe(0);
      expect(env.settings.values.has('settings:tenant:tenant-a:security')).toBe(false);
      expect([...env.settings.values.keys()].some((key) => key.includes('institution'))).toBe(
        false
      );
      // The platform's global assignment, which the restore did not write, is left as it was.
      expect(
        count(
          adminDb,
          "SELECT count(*) AS n FROM admin_role_assignments WHERE id='platform-assignment'"
        )
      ).toBe(1);
    } finally {
      env.close();
    }
  }, 120_000);

  it('waits out earlier restore leases and projection runs before it finishes', async () => {
    const env = await environment();
    try {
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      const started = env.now.value;
      const { operation } = await env.drive();
      expect(operation?.state).toBe('cancelled');
      expect(operation!.updated_at - started).toBeGreaterThanOrEqual(
        TENANT_BACKUP_IMPORT_DISCARD_LEASE_WAIT_MS + TENANT_BACKUP_IMPORT_DISCARD_PROJECTION_WAIT_MS
      );
    } finally {
      env.close();
    }
  }, 120_000);

  it('stops before deleting anything when the restored data holds a legal hold', async () => {
    const env = await environment({ legalHold: true });
    const { core, admin: adminDb } = env.databases;
    try {
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      const { operation, codes } = await env.drive(10);
      expect(operation?.state).toBe('cancelling');
      expect(codes).toContain('backup_import_cleanup_legal_hold');
      // Later ticks keep stopping on it: the decision and the stop were recorded together.
      expect((await env.drive(3)).codes).toEqual(['backup_import_cleanup_legal_hold']);
      expect(
        JSON.parse(
          (
            adminDb.prepare('SELECT blocker_json FROM tenant_backup_import_discards').get() as {
              blocker_json: string;
            }
          ).blocker_json
        )
      ).toEqual({ holdIds: ['hold-a'], restoredHolds: 1, bundleHoldIds: [], bundleHolds: 0 });
      expect(count(core, "SELECT count(*) AS n FROM users_core WHERE tenant_id='tenant-a'")).toBe(
        2
      );
      expect(core.prepare("SELECT lifecycle_state FROM tenants WHERE id='tenant-a'").get()).toEqual(
        {
          lifecycle_state: 'provisioning',
        }
      );
    } finally {
      env.close();
    }
  }, 120_000);

  it('stops on legal holds in the bundle that were not restored yet', async () => {
    const env = await environment({ bundleHolds: 2 });
    const { core, admin: adminDb } = env.databases;
    try {
      // The validated input still lists the holds' keys.
      adminDb.exec(`
        INSERT INTO tenant_backup_validation_sessions(id,tenant_id,operation_id,fencing_token,state,created_at)
        VALUES ('session-a','tenant-a','${OPERATION}',1,'sealed',1);
        INSERT INTO tenant_backup_validation_records(session_id,tenant_id,module,collection,record_id,bundle_id)
        VALUES ('session-a','tenant-a','core','core.legal_holds','[["text","hold-in-bundle"]]','${'a'.repeat(32)}');
      `);
      adminDb
        .prepare(
          `INSERT INTO tenant_backup_input_validations
          (operation_id,tenant_id,session_id,input_inventory_digest,examined_references,unresolved_provenance)
          VALUES (?,'tenant-a','session-a',?,0,0)`
        )
        .run(OPERATION, digest('e'));
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      const { codes } = await env.drive(10);
      expect(codes).toContain('backup_import_cleanup_legal_hold');
      expect(
        JSON.parse(
          (
            adminDb.prepare('SELECT blocker_json FROM tenant_backup_import_discards').get() as {
              blocker_json: string;
            }
          ).blocker_json
        )
      ).toEqual({
        holdIds: [],
        restoredHolds: 0,
        bundleHoldIds: ['hold-in-bundle'],
        bundleHolds: 2,
      });
      expect(count(core, "SELECT count(*) AS n FROM users_core WHERE tenant_id='tenant-a'")).toBe(
        2
      );
    } finally {
      env.close();
    }
  }, 120_000);

  it('leaves a parent row a cascade would take from another tenant and stops', async () => {
    const env = await environment();
    const { core } = env.databases;
    try {
      // Tenant b's session points at tenant a's user: deleting the user would cascade into it.
      core.exec(
        "INSERT INTO sessions(id,user_id,tenant_id,expires_at,created_at) VALUES ('session-b-on-a','user-a','tenant-b',9,1)"
      );
      const before = env.tenantB();
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      const { operation, codes } = await env.drive(10);
      expect(operation?.state).toBe('cancelling');
      expect(codes).toContain('backup_import_cleanup_blocked');
      expect(env.tenantB()).toEqual(before);
      expect(count(core, "SELECT count(*) AS n FROM users_core WHERE id='user-a'")).toBe(1);
      // The other restored user had no such reference and is gone.
      expect(count(core, "SELECT count(*) AS n FROM users_core WHERE id='user-a2'")).toBe(0);
    } finally {
      env.close();
    }
  }, 120_000);

  it('fences the earlier restore lease and lets another tenant import into the shared Admin', async () => {
    const env = await environment();
    const { core, admin: adminDb } = env.databases;
    try {
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      expect((await env.drive()).operation?.state).toBe('cancelled');
      // The restore writer of the cancelled lease cannot reopen its target.
      await expect(
        SqliteRestoreTarget.open({
          database: adapter(core),
          identity: {
            id: `${OPERATION}:core-db`,
            tenantId: 'tenant-a',
            operationId: OPERATION,
            resourceId: 'core-db',
            planDigest: digest('2'),
            seedFingerprint: digest('3'),
          },
          lease: {
            owner: 'restore-worker',
            fencingToken: env.lease.fencingToken,
            expiresAt: env.now.value + 60_000,
          },
          now: () => env.now.value,
          authorize: async () => {},
        })
      ).rejects.toThrow('backup_restore_target_rejected');
      // Admin keeps one receipt per tenant, so tenant b can still start a restore there.
      adminDb
        .prepare(
          `INSERT INTO tenant_backup_restore_targets
          (id,tenant_id,operation_id,resource_id,plan_digest,seed_fingerprint,owner,fencing_token,lease_expires_at,state)
          VALUES ('b-target','tenant-b','b-import','admin-db',?,?,'worker',1,1,'loading')`
        )
        .run(digest('8'), digest('9'));
      expect(() =>
        adminDb
          .prepare(
            `INSERT INTO tenant_backup_restore_targets
            (id,tenant_id,operation_id,resource_id,plan_digest,seed_fingerprint,owner,fencing_token,lease_expires_at,state)
            VALUES ('a-again','tenant-a','a-import-2','admin-db',?,?,'worker',1,1,'loading')`
          )
          .run(digest('8'), digest('9'))
      ).toThrow();
    } finally {
      env.close();
    }
  }, 120_000);

  it('resumes after only the platform tenant was marked deleted', async () => {
    const env = await environment();
    const { core } = env.databases;
    try {
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      // Drive until the discard recorded the settings deletion, then undo the core half of the
      // lifecycle change as if the slice stopped between the two databases.
      for (let i = 0; i < 40; i++) {
        env.now.value += 60_000;
        await env.drive(1);
        const row = env.databases.admin
          .prepare('SELECT settings_deleted_at FROM tenant_backup_import_discards')
          .get() as { settings_deleted_at: number | null } | undefined;
        if (row?.settings_deleted_at) break;
      }
      core.prepare("UPDATE tenants SET lifecycle_state='provisioning' WHERE id='tenant-a'").run();
      const { operation } = await env.drive();
      expect(operation?.state).toBe('cancelled');
      expect(core.prepare("SELECT lifecycle_state FROM tenants WHERE id='tenant-a'").get()).toEqual(
        {
          lifecycle_state: 'deleted',
        }
      );
    } finally {
      env.close();
    }
  }, 120_000);

  it('removes a settings key a late projection wrote after the discard deleted its document', async () => {
    const env = await environment();
    try {
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      for (let i = 0; i < 40; i++) {
        await env.drive(1);
        const row = env.databases.admin
          .prepare('SELECT settings_deleted_at FROM tenant_backup_import_discards')
          .get() as { settings_deleted_at: number | null } | undefined;
        if (row?.settings_deleted_at) break;
      }
      // A projection that read the document before it was deleted writes its key afterwards,
      // and the next listings start with empty pages that are not the last ones.
      env.settings.values.set('settings:tenant:tenant-a:security', '{"late":true}');
      env.settings.emptyPages.value = 25;
      const { operation } = await env.drive();
      expect(operation?.state).toBe('cancelled');
      expect(env.settings.values.has('settings:tenant:tenant-a:security')).toBe(false);
    } finally {
      env.close();
    }
  }, 120_000);

  it('records and sweeps every client settings key of a large tenant', async () => {
    // One cleanup call deletes at most 8 statements of 50 rows (runTenantDiscardPage) and 100 KV
    // keys (KV_KEYS_PER_PAGE), recording where the KV pass continues. 402 settings documents (401
    // clients and the tenant's) need a second discard call; 201 keys make the middle sweep call
    // resume a recorded pass and record it again. Every working tick re-plans the discard, so
    // larger counts only add ticks.
    const env = await environment({ clients: 401, clientKeys: 201 });
    const prefix = 'settings:client:tenant-a:';
    const clientKeys = () =>
      [...env.settings.values.keys()].filter((key) => key.startsWith(prefix)).length;
    const documents = () =>
      count(
        env.databases.admin,
        "SELECT count(*) AS n FROM tenant_settings_documents WHERE tenant_id='tenant-a'"
      );
    try {
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      const documentsLeft: number[] = [];
      const deletedPerCall: number[] = [];
      const recordedMidPass: number[] = [];
      let operation: Awaited<ReturnType<typeof env.drive>>['operation'] = null;
      for (let i = 0; i < 60 && !['cancelled', 'failed'].includes(operation?.state ?? ''); i++) {
        const [keys, rows] = [clientKeys(), documents()];
        ({ operation } = await env.drive(1));
        if (documents() < rows) documentsLeft.push(documents());
        if (clientKeys() < keys) deletedPerCall.push(keys - clientKeys());
        const row = env.databases.admin
          .prepare('SELECT kv_sweep_json FROM tenant_backup_import_discards')
          .get() as { kv_sweep_json: string | null } | undefined;
        const sweep = JSON.parse(row?.kv_sweep_json ?? '{}')[prefix];
        if (sweep?.cursor) recordedMidPass.push(sweep.deleted);
      }
      // Which rows a page deletes is unordered, so only the counts are fixed.
      expect(documentsLeft).toEqual([2, 0]);
      expect(deletedPerCall).toEqual([100, 100, 1]);
      expect(recordedMidPass).toEqual([100, 200]);
      expect(operation?.state).toBe('cancelled');
      expect([...env.settings.values.keys()].filter((key) => key.includes('tenant-a'))).toEqual([]);
    } finally {
      env.close();
    }
  }, 120_000);

  it('stops on a schema change and resumes once the schema is back', async () => {
    const env = await environment();
    const { core, admin: adminDb } = env.databases;
    try {
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      // Let the cleanup decide (3.5 minutes), then change the core schema before it deletes.
      for (let i = 0; i < 10; i++) {
        await env.drive(1);
        const row = adminDb.prepare('SELECT decision FROM tenant_backup_import_discards').get() as
          | { decision: string | null }
          | undefined;
        if (row?.decision) break;
      }
      core.exec('CREATE INDEX late_addition ON users_core(created_at)');
      const stopped = await env.drive(3);
      expect(stopped.codes).toContain('backup_import_cleanup_schema_changed');
      expect(count(core, "SELECT count(*) AS n FROM users_core WHERE tenant_id='tenant-a'")).toBe(
        2
      );
      core.exec('DROP INDEX late_addition');
      const { operation } = await env.drive();
      expect(operation?.state).toBe('cancelled');
      expect(count(core, "SELECT count(*) AS n FROM users_core WHERE tenant_id='tenant-a'")).toBe(
        0
      );
    } finally {
      env.close();
    }
  }, 120_000);

  it('never runs a plan built on another schema than the recorded one', async () => {
    const env = await environment();
    const { core, admin: adminDb } = env.databases;
    try {
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      for (let i = 0; i < 10; i++) {
        await env.drive(1);
        const row = adminDb.prepare('SELECT decision FROM tenant_backup_import_discards').get() as
          | { decision: string | null }
          | undefined;
        if (row?.decision) break;
      }
      // The next lease plans on a changed schema, which is reverted to the recorded one right
      // after planning: the recorded and current schemas match, but the plan does not.
      core.exec('CREATE INDEX plan_only ON users_core(created_at)');
      // Reads 1-3 belong to the planning of a lease; the 4th is the check before a delete.
      let reverted = false;
      env.coreSchemaReads.onRead = (read) => {
        if (read === 4 && !reverted) {
          reverted = true;
          core.exec('DROP INDEX IF EXISTS plan_only');
        }
      };
      const codes: string[] = [];
      for (let i = 0; i < 5 && !reverted; i++) codes.push(...(await env.drive(1)).codes);
      env.coreSchemaReads.onRead = undefined;
      expect(reverted).toBe(true);
      expect(codes).toContain('backup_import_cleanup_schema_changed');
      expect(
        adminDb.prepare('SELECT blocker_kind FROM tenant_backup_import_discards').get()
      ).toEqual({ blocker_kind: 'schema_changed' });
      expect(count(core, "SELECT count(*) AS n FROM users_core WHERE tenant_id='tenant-a'")).toBe(
        2
      );
      // A later lease plans on the recorded schema again and finishes.
      const { operation } = await env.drive();
      expect(operation?.state).toBe('cancelled');
    } finally {
      env.close();
    }
  }, 120_000);

  it('rejects a plan read while a foreign key changed and changed back', async () => {
    const env = await environment();
    const { core, admin: adminDb } = env.databases;
    const sessionsWith = (action: string) => `
      PRAGMA foreign_keys = OFF;
      CREATE TABLE sessions_next(id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, external_provider_id TEXT,
        external_provider_sub TEXT, tenant_id TEXT NOT NULL DEFAULT 'default',
        external_provider_sid TEXT,
        FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE ${action});
      INSERT INTO sessions_next SELECT id,user_id,expires_at,created_at,external_provider_id,
        external_provider_sub,tenant_id,external_provider_sid FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_next RENAME TO sessions;
      PRAGMA foreign_keys = ON;`;
    try {
      core.exec(
        "INSERT INTO sessions(id,user_id,tenant_id,expires_at,created_at) VALUES ('session-b-on-a','user-a','tenant-b',9,1)"
      );
      core.exec(sessionsWith('CASCADE'));
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      for (let i = 0; i < 10; i++) {
        await env.drive(1);
        const row = adminDb.prepare('SELECT decision FROM tenant_backup_import_discards').get() as
          | { decision: string | null }
          | undefined;
        if (row?.decision) break;
      }
      // While the planner reads the sessions page, its foreign key briefly does not cascade.
      let swapped = false;
      env.coreSchemaReads.onPage = (sql, when) => {
        if (!sql.includes("pragma_foreign_key_list('sessions')")) return;
        if (when === 'before') swapped = true;
        core.exec(sessionsWith(when === 'before' ? 'NO ACTION' : 'CASCADE'));
      };
      const codes: string[] = [];
      for (let i = 0; i < 20 && !swapped; i++) codes.push(...(await env.drive(1)).codes);
      env.coreSchemaReads.onPage = undefined;
      expect(swapped).toBe(true);
      expect(codes).toContain('backup_import_discard_schema_moving');
      expect(core.prepare("SELECT id FROM sessions WHERE id='session-b-on-a'").get()).toEqual({
        id: 'session-b-on-a',
      });
    } finally {
      env.close();
    }
  }, 120_000);

  it('rejects a plan whose table list missed a table that came back', async () => {
    const env = await environment();
    const { core, admin: adminDb } = env.databases;
    try {
      core.exec(
        "INSERT INTO sessions(id,user_id,tenant_id,expires_at,created_at) VALUES ('session-b-on-a','user-a','tenant-b',9,1)"
      );
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      for (let i = 0; i < 10; i++) {
        await env.drive(1);
        const row = adminDb.prepare('SELECT decision FROM tenant_backup_import_discards').get() as
          | { decision: string | null }
          | undefined;
        if (row?.decision) break;
      }
      // sessions is away only while the planner lists the tables.
      let hidden = false;
      let saved: { sql: string; rows: Record<string, unknown>[] } | undefined;
      env.coreSchemaReads.onPage = (sql, when) => {
        if (!sql.startsWith("SELECT name FROM sqlite_schema WHERE type='table'")) return;
        if (when === 'before') hidden = true;
        if (when === 'before') {
          saved = {
            // The table first, then its indexes and triggers, exactly as they were.
            sql: (
              core
                .prepare(
                  "SELECT sql FROM sqlite_schema WHERE tbl_name='sessions' AND sql IS NOT NULL ORDER BY type='table' DESC, name"
                )
                .all() as { sql: string }[]
            )
              .map(({ sql }) => `${sql};`)
              .join('\n'),
            rows: core.prepare('SELECT * FROM sessions').all() as Record<string, unknown>[],
          };
          core.exec('PRAGMA foreign_keys = OFF; DROP TABLE sessions; PRAGMA foreign_keys = ON');
        } else if (saved) {
          const [table, ...rest] = saved.sql.split(';\n');
          core.exec(`${table.replace(/;$/, '')};`);
          for (const row of saved.rows)
            core
              .prepare(
                `INSERT INTO sessions(${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
                  .map(() => '?')
                  .join(',')})`
              )
              .run(...Object.values(row));
          if (rest.length) core.exec(rest.join(';\n'));
        }
      };
      const codes: string[] = [];
      for (let i = 0; i < 20 && !hidden; i++) codes.push(...(await env.drive(1)).codes);
      env.coreSchemaReads.onPage = undefined;
      expect(hidden).toBe(true);
      expect(codes).toContain('backup_import_discard_schema_moving');
      expect(core.prepare("SELECT id FROM sessions WHERE id='session-b-on-a'").get()).toEqual({
        id: 'session-b-on-a',
      });
    } finally {
      env.close();
    }
  }, 120_000);

  it('finishes a cancel before any write even when the schema cannot be discarded', async () => {
    const env = await environment({ written: false });
    try {
      env.databases.core.exec('CREATE TABLE unreviewed_table(id TEXT PRIMARY KEY)');
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      const { operation } = await env.drive();
      expect(operation?.state).toBe('cancelled');
    } finally {
      env.close();
    }
  }, 120_000);

  it('removes nothing when the import was cancelled before it opened a restore target', async () => {
    const env = await environment({ written: false });
    const { core, admin: adminDb } = env.databases;
    try {
      await env.store.requestCancel('tenant-a', OPERATION, env.now.value);
      const { operation } = await env.drive();
      expect(operation?.state).toBe('cancelled');
      expect(count(core, "SELECT count(*) AS n FROM users_core WHERE tenant_id='tenant-a'")).toBe(
        2
      );
      expect(core.prepare("SELECT lifecycle_state FROM tenants WHERE id='tenant-a'").get()).toEqual(
        {
          lifecycle_state: 'provisioning',
        }
      );
      expect(adminDb.prepare('SELECT decision FROM tenant_backup_import_discards').get()).toEqual({
        decision: 'none',
      });
    } finally {
      env.close();
    }
  }, 120_000);
});
