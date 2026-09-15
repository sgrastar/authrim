// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';
import { createTenantBackupR2CatalogLister } from '../tenant-backup-r2-catalog-lister';

type SqlInputValue = string | number | bigint | null | Uint8Array;
let core: DatabaseSync;
let admin: DatabaseSync;

function adapter(database: DatabaseSync): DatabaseAdapter {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...(params as SqlInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (database.prepare(sql).get(...(params as SqlInputValue[])) as T | undefined) ?? null;
    },
    async execute() {
      throw new Error('unexpected_write');
    },
    async transaction(callback) {
      return callback(this);
    },
    async batch() {
      throw new Error('unexpected_write');
    },
    async isHealthy() {
      return { healthy: true, latencyMs: 0, type: 'd1' };
    },
    getType() {
      return 'd1';
    },
    async close() {},
  };
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE object_catalog(
      id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,object_class TEXT NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE object_catalog_objects(
      id TEXT PRIMARY KEY NOT NULL,catalog_id TEXT NOT NULL,bucket_binding TEXT NOT NULL,
      object_key TEXT NOT NULL,key_version INTEGER NOT NULL,checksum_sha256 TEXT,
      total_bytes INTEGER,deleted_at INTEGER
    );
    CREATE TABLE sensitive_detail_chunk_index(
      catalog_id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,object_key TEXT NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE log_object_catalog(
      id TEXT PRIMARY KEY NOT NULL,tenant_key TEXT NOT NULL,log_type TEXT NOT NULL,
      plane TEXT NOT NULL,object_key TEXT NOT NULL,object_kind TEXT NOT NULL,status TEXT NOT NULL,
      record_count INTEGER NOT NULL,byte_count INTEGER NOT NULL,checksum_sha256 TEXT,
      compression TEXT,encryption_scope TEXT,key_version INTEGER,created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE log_chunk_record_index(
      record_id TEXT NOT NULL,tenant_key TEXT NOT NULL,log_type TEXT NOT NULL,plane TEXT NOT NULL,
      object_catalog_id TEXT NOT NULL,chunk_id TEXT NOT NULL,event_at INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `);
}

function context(selection?: Partial<AdapterContext['selection']>): AdapterContext {
  return {
    context: {
      operation: { created_at: 10 * 86_400_000 },
      lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
      signal: new AbortController().signal,
    },
    databases: {
      tenant: [
        {
          databaseId: 'core-a',
          runtimeGeneration: 1,
          deploymentTarget: null,
          assignments: [
            {
              role: 'tenant_core',
              dataRole: 'primary',
              residencyPartition: 'global',
              shardId: 'shard-a',
              assignmentGeneration: 1,
              bindingRouteGeneration: 1,
              generation: 1,
              schemaVersion: 1,
              bindingRef: 'DB',
            },
          ],
          database: adapter(core),
        },
      ],
      fixed: [
        {
          binding: 'DB_ADMIN',
          family: 'admin',
          databaseId: 'admin-a',
          database: adapter(admin),
        },
      ],
    },
    selection: {
      settings: false,
      users: false,
      admin: false,
      artifacts: true,
      logs: { audit: true, other: false, sensitive: false, period: 7 },
      ...selection,
    },
  } as AdapterContext;
}

function insertLog(
  database: DatabaseSync,
  input: {
    id: string;
    tenantKey?: string;
    logType?: string;
    plane?: string;
    events: number[];
  }
): void {
  const tenantKey = input.tenantKey ?? 'tenant-key-a';
  const logType = input.logType ?? 'audit';
  const plane = input.plane ?? 'archive';
  database
    .prepare(
      `INSERT INTO log_object_catalog VALUES(?,?,?,?,?,'chunk','committed',?,?,?,'gzip_block',?,?,?,NULL)`
    )
    .run(
      input.id,
      tenantKey,
      logType,
      plane,
      `logs/${input.id}`,
      input.events.length,
      100,
      'b'.repeat(64),
      'scope-a',
      2,
      input.events[0]
    );
  for (const [index, eventAt] of input.events.entries())
    database
      .prepare(`INSERT INTO log_chunk_record_index VALUES(?,?,?,?,?,?,?,'committed')`)
      .run(
        `${input.id}-record-${index}`,
        tenantKey,
        logType,
        plane,
        input.id,
        `${input.id}-chunk`,
        eventAt
      );
}

beforeEach(() => {
  core = new DatabaseSync(':memory:');
  admin = new DatabaseSync(':memory:');
  createSchema(core);
  createSchema(admin);
});

afterEach(() => {
  core.close();
  admin.close();
});

describe('tenant backup R2 catalog lister', () => {
  it('lists tenant-owned Core and Admin object rows and excludes recursive DR bundles', async () => {
    core.exec(`
      INSERT INTO object_catalog VALUES('catalog-a','tenant-a','user_export',NULL);
      INSERT INTO object_catalog_objects VALUES(
        'physical-a','catalog-a','EXPORT_ARTIFACTS','exports/a','2','${'a'.repeat(64)}',12,NULL
      );
      INSERT INTO object_catalog VALUES('catalog-dr','tenant-a','dr_bundle',NULL);
      INSERT INTO object_catalog_objects VALUES(
        'physical-dr','catalog-dr','EXPORT_ARTIFACTS','exports/dr','2',NULL,12,NULL
      );
      INSERT INTO object_catalog VALUES('catalog-other','tenant-b','user_export',NULL);
      INSERT INTO object_catalog_objects VALUES(
        'physical-other','catalog-other','EXPORT_ARTIFACTS','exports/other','2',NULL,12,NULL
      );
    `);
    admin.exec(`
      INSERT INTO object_catalog VALUES('catalog-b','tenant-a','user_import_input',NULL);
      INSERT INTO object_catalog_objects VALUES(
        'physical-b','catalog-b','IMPORT_ARTIFACTS','imports/b','1',NULL,20,NULL
      );
    `);
    const list = createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' });

    const rows = await list(context(), 'artifacts.object_catalog_bodies');

    expect(rows.map(({ objectId }) => objectId)).toEqual(['admin:physical-b', 'core:physical-a']);
    expect(rows.map(({ sourceEncoding }) => sourceEncoding)).toEqual([
      'plaintext',
      'object_artifact_v1',
    ]);
    expect(rows.every(({ context: value }) => value.tenantId === 'tenant-a')).toBe(true);
  });

  it('selects only complete log chunks in the requested category and fixed period', async () => {
    insertLog(core, { id: 'audit-a', events: [4 * 86_400_000, 5 * 86_400_000] });
    insertLog(core, { id: 'normal-a', logType: 'normal', events: [5 * 86_400_000] });
    insertLog(admin, {
      id: 'foreign-a',
      tenantKey: 'tenant-key-b',
      events: [5 * 86_400_000],
    });
    const list = createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' });

    const rows = await list(context(), 'logs.archive_object_bodies');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      objectId: 'core:audit-a',
      bucketBinding: 'AUDIT_ARCHIVE',
      sourceEncoding: 'log_chunk_v1',
      context: { logType: 'audit', chunkId: 'audit-a-chunk' },
    });
  });

  it('maps diagnostic and sensitive log planes to their actual buckets', async () => {
    insertLog(core, {
      id: 'diagnostic-a',
      logType: 'diagnostic',
      plane: 'diagnostic_detail',
      events: [5 * 86_400_000],
    });
    insertLog(admin, {
      id: 'sensitive-a',
      logType: 'admin_audit',
      plane: 'sensitive_detail',
      events: [5 * 86_400_000],
    });
    const list = createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' });
    const input = context({
      logs: { audit: true, other: true, sensitive: true, period: 7 },
    });

    const rows = await list(input, 'logs.archive_object_bodies');

    expect(rows.map(({ objectId, bucketBinding }) => [objectId, bucketBinding])).toEqual([
      ['admin:sensitive-a', 'SENSITIVE_DETAILS'],
      ['core:diagnostic-a', 'DIAGNOSTIC_LOGS'],
    ]);
  });

  it('rejects committed log metadata without matching committed indexes', async () => {
    core.exec(`
      INSERT INTO log_object_catalog VALUES(
        'broken-a','tenant-key-a','audit','archive','logs/broken-a','chunk','committed',
        1,100,'${'d'.repeat(64)}','gzip_block','scope-a',2,432000000,NULL
      );
    `);
    const list = createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' });

    await expect(list(context(), 'logs.archive_object_bodies')).rejects.toThrow(
      'backup_r2_catalog_list_invalid'
    );
  });

  it('fails closed when a log chunk crosses the requested period boundary', async () => {
    insertLog(core, { id: 'split-a', events: [2 * 86_400_000, 4 * 86_400_000] });
    const list = createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' });

    await expect(list(context(), 'logs.archive_object_bodies')).rejects.toThrow(
      'backup_r2_catalog_log_window_requires_repack'
    );
  });

  it('fails closed instead of copying a shared sensitive-detail body', async () => {
    core.exec(`
      INSERT INTO object_catalog VALUES('catalog-a','tenant-a','pii_log_values',NULL);
      INSERT INTO object_catalog_objects VALUES(
        'physical-a','catalog-a','SENSITIVE_DETAILS','details/shared','2','${'c'.repeat(64)}',12,NULL
      );
      INSERT INTO sensitive_detail_chunk_index VALUES(
        'catalog-a','tenant-a','details/shared',NULL
      );
    `);
    const list = createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' });

    await expect(list(context(), 'artifacts.object_catalog_bodies')).rejects.toThrow(
      'backup_r2_catalog_shared_detail_requires_repack'
    );
  });
});
