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
      catalog_id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,object_class TEXT NOT NULL,
      object_key TEXT NOT NULL,content_encoding TEXT NOT NULL,line_number INTEGER NOT NULL,
      byte_offset INTEGER,byte_length INTEGER,key_version INTEGER NOT NULL,
      checksum_sha256 TEXT,created_at INTEGER NOT NULL,deleted_at INTEGER
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
    CREATE TABLE logging_dlq_items(
      id TEXT PRIMARY KEY NOT NULL,tenant_key TEXT NOT NULL,payload_object_ref TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE logging_message_jobs(
      id TEXT PRIMARY KEY NOT NULL,tenant_key TEXT NOT NULL,payload_object_ref TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,status TEXT NOT NULL
    );
  `);
}

function context(selection?: Partial<AdapterContext['selection']>): AdapterContext {
  return {
    boundaryUnixMs: 10 * 86_400_000,
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
        'physical-b','catalog-b','IMPORT_ARTIFACTS','imports/b','1','${'b'.repeat(64)}',20,NULL
      );
    `);
    const list = createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' });

    const rows = await list(context(), 'artifacts.object_catalog_bodies');

    expect(rows.map(({ objectId }) => objectId)).toEqual([
      'admin:admin-a:physical-b',
      'core:core-a:physical-a',
    ]);
    expect(rows.map(({ sourceEncoding }) => sourceEncoding)).toEqual([
      'plaintext',
      'object_artifact_v1',
    ]);
    expect(rows.every(({ context: value }) => value.tenantId === 'tenant-a')).toBe(true);
  });

  it('keeps identical catalog row IDs distinct across Core databases', async () => {
    const secondCore = new DatabaseSync(':memory:');
    try {
      createSchema(secondCore);
      for (const database of [core, secondCore])
        database.exec(`
          INSERT INTO object_catalog VALUES('catalog-a','tenant-a','user_export',NULL);
          INSERT INTO object_catalog_objects VALUES(
            'physical-a','catalog-a','EXPORT_ARTIFACTS','exports/a','2','${'a'.repeat(64)}',12,NULL
          );
        `);
      const input = context();
      input.databases.tenant.push({
        ...input.databases.tenant[0],
        databaseId: 'core-b',
        database: adapter(secondCore),
      });

      const rows = await createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' })(
        input,
        'artifacts.object_catalog_bodies'
      );

      expect(rows.map(({ objectId }) => objectId)).toEqual([
        'core:core-a:physical-a',
        'core:core-b:physical-a',
      ]);
    } finally {
      secondCore.close();
    }
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
      objectId: 'core:core-a:audit-a',
      bucketBinding: 'AUDIT_ARCHIVE',
      sourceEncoding: 'log_chunk_records_v1',
      context: { logType: 'audit', chunkId: 'audit-a-chunk' },
    });
  });

  it('includes runnable logging payloads as quarantined restore holds with Admin data', async () => {
    admin.exec(`
      INSERT INTO logging_dlq_items VALUES(
        'dlq-a','tenant-key-a','dlq/tenant-a/a.json','open'
      );
      INSERT INTO logging_dlq_items VALUES(
        'dlq-closed','tenant-key-a','dlq/tenant-a/closed.json','purged'
      );
      INSERT INTO logging_message_jobs VALUES(
        'job-a','tenant-key-a','jobs/tenant-a/a.json','${'a'.repeat(64)}','queued'
      );
      INSERT INTO logging_message_jobs VALUES(
        'job-other','tenant-key-b','jobs/tenant-b/a.json','${'b'.repeat(64)}','queued'
      );
    `);

    const rows = await createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' })(
      context({ admin: true, logs: { audit: false, other: false, sensitive: false, period: 7 } }),
      'logs.archive_object_bodies'
    );

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectKey: 'dlq/tenant-a/a.json',
          sourceEncoding: 'object_artifact_v1',
          context: expect.objectContaining({
            catalogKind: 'restore_hold_payload',
            holdDatasetId: 'admin.logging_dlq_items',
          }),
        }),
        expect.objectContaining({
          objectKey: 'jobs/tenant-a/a.json',
          context: expect.objectContaining({
            catalogKind: 'restore_hold_payload',
            expectedPlaintextSha256: 'a'.repeat(64),
            holdDatasetId: 'admin.logging_message_jobs',
          }),
        }),
      ])
    );
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
      ['admin:admin-a:sensitive-a', 'SENSITIVE_DETAILS'],
      ['core:core-a:diagnostic-a', 'DIAGNOSTIC_LOGS'],
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

  it('rejects a catalog object without a durable content checksum', async () => {
    core.exec(`
      INSERT INTO object_catalog VALUES('catalog-a','tenant-a','user_export',NULL);
      INSERT INTO object_catalog_objects VALUES(
        'physical-a','catalog-a','EXPORT_ARTIFACTS','exports/a','2',NULL,12,NULL
      );
    `);

    await expect(
      createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' })(
        context(),
        'artifacts.object_catalog_bodies'
      )
    ).rejects.toThrow('backup_r2_catalog_list_invalid');
  });

  it('marks a log chunk that crosses the requested period boundary for record repacking', async () => {
    insertLog(core, { id: 'split-a', events: [2 * 86_400_000, 4 * 86_400_000] });
    const list = createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' });

    await expect(list(context(), 'logs.archive_object_bodies')).resolves.toMatchObject([
      {
        objectId: 'core:core-a:split-a',
        sourceEncoding: 'log_chunk_records_v1',
        context: {
          sourceDatabaseId: 'core-a',
          windowFromInclusiveUnixMs: 3 * 86_400_000,
          windowUntilInclusiveUnixMs: 10 * 86_400_000,
        },
      },
    ]);
  });

  it('lists one portable record instead of copying a shared log-detail body', async () => {
    core.exec(`
      INSERT INTO object_catalog VALUES('catalog-a','tenant-a','event_log_detail',NULL);
      INSERT INTO object_catalog_objects VALUES(
        'physical-a','catalog-a','SENSITIVE_DETAILS','details/shared','2','${'c'.repeat(64)}',12,NULL
      );
      INSERT INTO sensitive_detail_chunk_index VALUES(
        'catalog-a','tenant-a','event_log_detail','details/shared','gzip',3,NULL,NULL,2,
        '${'c'.repeat(64)}',432000000,NULL
      );
    `);
    const list = createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' });

    await expect(
      list(
        context({ logs: { audit: false, other: true, sensitive: true, period: 7 } }),
        'artifacts.object_catalog_bodies'
      )
    ).resolves.toMatchObject([
      {
        objectId: 'core:core-a:physical-a',
        sourceEncoding: 'sensitive_detail_record_v1',
        context: {
          catalogId: 'catalog-a',
          contentEncoding: 'gzip',
          lineNumber: 3,
        },
      },
    ]);
  });

  it('does not list historical artifacts or sensitive details outside the chosen categories', async () => {
    core.exec(`
      INSERT INTO object_catalog VALUES('catalog-a','tenant-a','pii_log_values',NULL);
      INSERT INTO object_catalog_objects VALUES(
        'physical-a','catalog-a','SENSITIVE_DETAILS','details/shared','2','${'c'.repeat(64)}',12,NULL
      );
      INSERT INTO sensitive_detail_chunk_index VALUES(
        'catalog-a','tenant-a','pii_log_values','details/shared','none',0,0,11,2,
        '${'c'.repeat(64)}',432000000,NULL
      );
      INSERT INTO object_catalog VALUES('catalog-b','tenant-a','user_export',NULL);
      INSERT INTO object_catalog_objects VALUES(
        'physical-b','catalog-b','EXPORT_ARTIFACTS','exports/b','2','${'d'.repeat(64)}',12,NULL
      );
    `);
    const list = createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' });

    await expect(
      list(
        context({
          artifacts: false,
          logs: { audit: false, other: false, sensitive: false, period: 7 },
        }),
        'artifacts.object_catalog_bodies'
      )
    ).resolves.toEqual([]);
  });

  it('follows Admin and user ownership for non-log sensitive detail references', async () => {
    core.exec(`
      INSERT INTO object_catalog VALUES('catalog-webhook','tenant-a','webhook_delivery_payload',NULL);
      INSERT INTO object_catalog_objects VALUES(
        'physical-webhook','catalog-webhook','SENSITIVE_DETAILS','details/webhook','2','${'c'.repeat(64)}',12,NULL
      );
      INSERT INTO sensitive_detail_chunk_index VALUES(
        'catalog-webhook','tenant-a','webhook_delivery_payload','details/webhook','none',0,0,11,2,
        '${'c'.repeat(64)}',1,NULL
      );
      INSERT INTO object_catalog VALUES('catalog-pii','tenant-a','pii_log_values',NULL);
      INSERT INTO object_catalog_objects VALUES(
        'physical-pii','catalog-pii','SENSITIVE_DETAILS','details/pii','2','${'d'.repeat(64)}',12,NULL
      );
      INSERT INTO sensitive_detail_chunk_index VALUES(
        'catalog-pii','tenant-a','pii_log_values','details/pii','none',0,0,11,2,
        '${'d'.repeat(64)}',432000000,NULL
      );
    `);
    admin.exec(`
      INSERT INTO object_catalog VALUES('catalog-approval','tenant-a','approval_transport_detail',NULL);
      INSERT INTO object_catalog_objects VALUES(
        'physical-approval','catalog-approval','SENSITIVE_DETAILS','details/approval','2','${'e'.repeat(64)}',12,NULL
      );
      INSERT INTO sensitive_detail_chunk_index VALUES(
        'catalog-approval','tenant-a','approval_transport_detail','details/approval','none',0,0,11,2,
        '${'e'.repeat(64)}',1,NULL
      );
    `);
    const list = createTenantBackupR2CatalogLister({ tenantKey: 'tenant-key-a' });

    const rows = await list(
      context({
        artifacts: false,
        users: true,
        admin: true,
        logs: { audit: false, other: false, sensitive: true, period: 7 },
      }),
      'artifacts.object_catalog_bodies'
    );

    expect(rows.map(({ objectId }) => objectId)).toEqual([
      'admin:admin-a:physical-approval',
      'core:core-a:physical-webhook',
    ]);
  });
});
