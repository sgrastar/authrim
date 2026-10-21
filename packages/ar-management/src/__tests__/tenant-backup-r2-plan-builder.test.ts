// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import type { PortableR2DatasetId } from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotTriggers,
  type CaptureSchema,
  type SnapshotTableSchema,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-snapshot';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';
import { prepareTenantBackupR2Plans } from '../tenant-backup-r2-plan-builder';
import type { DeferredEncryptedTenantBackupRecordSnapshotPort } from '../tenant-backup-record-snapshot-port';

type SqlValue = string | number | bigint | null | Uint8Array;
const TENANT = 'tenant-a';
const TENANT_KEY = 'key-a';
const BOUNDARY = 100 * 86_400_000;
const SHA = 'a'.repeat(64);

const logCatalog: SnapshotTableSchema = {
  table: 'log_object_catalog',
  tenantColumn: 'tenant_key',
  tenantIdentity: 'tenantKey',
  columns: [
    'id',
    'tenant_key',
    'log_type',
    'plane',
    'object_key',
    'object_kind',
    'status',
    'record_count',
    'byte_count',
    'checksum_sha256',
    'compression',
    'encryption_scope',
    'key_version',
    'created_at',
    'committed_at',
    'deleted_at',
  ],
  primaryKey: ['id'],
  uniqueKeys: [],
};
const recordIndex: SnapshotTableSchema = {
  table: 'log_chunk_record_index',
  tenantColumn: 'tenant_key',
  tenantIdentity: 'tenantKey',
  columns: [
    'record_id',
    'tenant_key',
    'log_type',
    'plane',
    'object_catalog_id',
    'chunk_id',
    'event_at',
    'status',
  ],
  primaryKey: ['tenant_key', 'log_type', 'plane', 'record_id'],
  uniqueKeys: [],
};
const objectCatalog: SnapshotTableSchema = {
  table: 'object_catalog',
  tenantColumn: 'tenant_id',
  columns: ['id', 'tenant_id', 'object_class', 'deleted_at'],
  primaryKey: ['id'],
  uniqueKeys: [],
};
const objects: CaptureSchema = {
  table: 'object_catalog_objects',
  columns: [
    'id',
    'catalog_id',
    'bucket_binding',
    'object_key',
    'key_version',
    'checksum_sha256',
    'total_bytes',
    'deleted_at',
  ],
  primaryKey: ['id'],
  uniqueKeys: [],
  parent: { schema: objectCatalog, childColumns: ['catalog_id'] },
};
const sensitive: SnapshotTableSchema = {
  table: 'sensitive_detail_chunk_index',
  tenantColumn: 'tenant_id',
  columns: [
    'catalog_id',
    'tenant_id',
    'object_class',
    'object_key',
    'content_encoding',
    'line_number',
    'byte_offset',
    'byte_length',
    'key_version',
    'checksum_sha256',
    'created_at',
    'deleted_at',
  ],
  primaryKey: ['catalog_id'],
  uniqueKeys: [],
};
const dlq: SnapshotTableSchema = {
  table: 'logging_dlq_items',
  tenantColumn: 'tenant_key',
  tenantIdentity: 'tenantKey',
  columns: ['id', 'tenant_key', 'payload_object_ref', 'status'],
  primaryKey: ['id'],
  uniqueKeys: [],
};
const jobs: SnapshotTableSchema = {
  table: 'logging_message_jobs',
  tenantColumn: 'tenant_key',
  tenantIdentity: 'tenantKey',
  columns: ['id', 'tenant_key', 'payload_object_ref', 'payload_sha256', 'status'],
  primaryKey: ['id'],
  uniqueKeys: [],
};
const SCHEMAS: readonly CaptureSchema[] = [
  logCatalog,
  recordIndex,
  objectCatalog,
  objects,
  sensitive,
  dlq,
  jobs,
];

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE log_object_catalog (id TEXT PRIMARY KEY NOT NULL, tenant_key TEXT NOT NULL,
      log_type TEXT NOT NULL, plane TEXT NOT NULL, object_key TEXT NOT NULL,
      object_kind TEXT NOT NULL, status TEXT NOT NULL, record_count INTEGER NOT NULL,
      byte_count INTEGER NOT NULL, checksum_sha256 TEXT, compression TEXT,
      encryption_scope TEXT, key_version INTEGER, created_at INTEGER NOT NULL,
      committed_at INTEGER, deleted_at INTEGER);
    CREATE TABLE log_chunk_record_index (record_id TEXT NOT NULL, tenant_key TEXT NOT NULL,
      log_type TEXT NOT NULL, plane TEXT NOT NULL, object_catalog_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL, event_at INTEGER NOT NULL, status TEXT NOT NULL,
      PRIMARY KEY (tenant_key, log_type, plane, record_id));
    CREATE INDEX idx_record_object ON log_chunk_record_index(object_catalog_id);
    CREATE TABLE object_catalog (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL,
      object_class TEXT NOT NULL, deleted_at INTEGER);
    CREATE TABLE object_catalog_objects (id TEXT PRIMARY KEY NOT NULL, catalog_id TEXT NOT NULL,
      bucket_binding TEXT NOT NULL, object_key TEXT NOT NULL, key_version INTEGER NOT NULL,
      checksum_sha256 TEXT, total_bytes INTEGER, deleted_at INTEGER);
    CREATE TABLE sensitive_detail_chunk_index (catalog_id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL, object_class TEXT NOT NULL, object_key TEXT NOT NULL,
      content_encoding TEXT NOT NULL, line_number INTEGER NOT NULL, byte_offset INTEGER,
      byte_length INTEGER, key_version INTEGER NOT NULL, checksum_sha256 TEXT,
      created_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE TABLE logging_dlq_items (id TEXT PRIMARY KEY NOT NULL, tenant_key TEXT NOT NULL,
      payload_object_ref TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE logging_message_jobs (id TEXT PRIMARY KEY NOT NULL, tenant_key TEXT,
      payload_object_ref TEXT NOT NULL, payload_sha256 TEXT NOT NULL, status TEXT NOT NULL);
    ${SQLITE_SNAPSHOT_SCHEMA}
    ${SCHEMAS.map((schema) => sqliteSnapshotTriggers(schema)).join('\n')}`);
  return db;
}

function adapter(db: DatabaseSync): DatabaseAdapter {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SqlValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SqlValue[])) as T | undefined) ?? null;
    },
  } as DatabaseAdapter;
}

function chunk(
  db: DatabaseSync,
  id: string,
  events: number[],
  overrides: Record<string, SqlValue> = {}
) {
  const row = {
    id,
    tenant_key: TENANT_KEY,
    log_type: 'audit',
    plane: 'archive',
    object_key: `logs/${id}`,
    object_kind: 'chunk',
    status: 'committed',
    record_count: events.length,
    byte_count: 10,
    checksum_sha256: SHA,
    compression: 'gzip_block',
    encryption_scope: 'tenant-log-archive',
    key_version: 1,
    created_at: events[0] ?? 0,
    committed_at: events[0] ?? 0,
    deleted_at: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO log_object_catalog VALUES (${logCatalog.columns.map(() => '?').join(',')})`
  ).run(...logCatalog.columns.map((column) => (row as Record<string, SqlValue>)[column]));
  for (const [index, eventAt] of events.entries())
    db.prepare('INSERT INTO log_chunk_record_index VALUES (?,?,?,?,?,?,?,?)').run(
      `${id}-r${index}`,
      row.tenant_key,
      row.log_type,
      row.plane,
      id,
      `chk-${id}`,
      eventAt,
      'committed'
    );
}

function startSnapshot(db: DatabaseSync, id: string) {
  db.prepare(
    "INSERT INTO tenant_backup_snapshots(id,tenant_id,state,tenant_key) VALUES (?,?,'capturing',?)"
  ).run(id, TENANT, TENANT_KEY);
}

function planned(): PlannedInstalledSqliteDataset[] {
  let ordinal = 0;
  return (['core', 'admin'] as const).flatMap((family) =>
    SCHEMAS.filter(
      (schema) =>
        family === 'admin' || !['logging_dlq_items', 'logging_message_jobs'].includes(schema.table)
    ).map((schema) => ({
      ordinal: ordinal++,
      firstOrdinal: 0,
      resourceId: `${family}-db`,
      family,
      table: schema.table,
      capture: schema,
      dataset: {
        id: `${family}.${schema.table}`,
        kind: 'log_dependencies',
        store: 'database',
        disposition: 'include',
      } as never,
    }))
  );
}

interface Recorded {
  pages: Map<number, string[]>;
  published: number | null;
  /** The call that last wrote a page and the one that published. */
  lastWriteCall: number;
  publishCall: number;
}

let currentCall = 0;

function recordingPort(recorded: Recorded): DeferredEncryptedTenantBackupRecordSnapshotPort {
  return {
    resourceId: 'r2-bodies:test',
    async writePlanPage(_context, _snapshotId, ordinal, plans) {
      if (recorded.published !== null) throw new Error('written after publication');
      recorded.lastWriteCall = currentCall;
      recorded.pages.set(
        ordinal,
        plans.map((plan) => new TextDecoder().decode(plan))
      );
    },
    async publishPlans(_context, _snapshotId, boundaryUnixMs, pages) {
      expect(boundaryUnixMs).toBe(BOUNDARY);
      recorded.published = pages;
      recorded.publishCall = currentCall;
    },
  } as DeferredEncryptedTenantBackupRecordSnapshotPort;
}

describe('R2 plans listed from the T0 snapshot after the hold', () => {
  let core: DatabaseSync;
  let admin: DatabaseSync;
  const databases = () => ({ 'core-db': core, 'admin-db': admin });
  const selection = {
    settings: true,
    users: true,
    admin: true,
    artifacts: true,
    logs: { audit: true, other: true, sensitive: true, period: 7 as const },
  };
  function context(overrides: Partial<AdapterContext['selection']> = {}): AdapterContext {
    return {
      context: {
        lease: { tenantId: TENANT, operationId: 'op', fencingToken: 1 },
        signal: new AbortController().signal,
      },
      selection: { ...selection, ...overrides },
      snapshotResources: {
        loadCapture: async (_lease: unknown, resourceId: string) => ({
          resourceId,
          snapshotId: `snap-${resourceId}`,
        }),
      },
      resolveSource: async ({ resourceId }: { resourceId: string }) =>
        adapter(databases()[resourceId as 'core-db' | 'admin-db']),
    } as unknown as AdapterContext;
  }
  async function prepareAll(
    datasets: PortableR2DatasetId[],
    input: AdapterContext = context(),
    sliceQueryBudget?: number
  ): Promise<{ recorded: Recorded[]; calls: number }> {
    const recorded = datasets.map(
      () => ({ pages: new Map(), published: null, lastWriteCall: -1, publishCall: -1 }) as Recorded
    );
    let cursor: string | null = null;
    let calls = 0;
    do {
      currentCall = calls;
      const result = await prepareTenantBackupR2Plans({
        context: input,
        planned: planned(),
        targets: datasets.map((datasetId, index) => ({
          datasetId,
          port: recordingPort(recorded[index]),
          snapshotId: `plans-${datasetId}`,
        })),
        tenantKey: TENANT_KEY,
        boundaryUnixMs: BOUNDARY,
        cursor,
        ...(sliceQueryBudget ? { sliceQueryBudget } : {}),
      });
      calls++;
      if (result.done) break;
      cursor = result.cursor;
    } while (calls < 1000);
    return { recorded, calls };
  }
  const plans = (recorded: Recorded) =>
    [...recorded.pages.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, page]) => page.map((plan) => JSON.parse(plan).descriptor));

  beforeEach(() => {
    core = createDatabase();
    admin = createDatabase();
  });
  afterEach(() => {
    core.close();
    admin.close();
  });

  it('plans whole committed chunks whose events reach into the window, as of T0', async () => {
    const day = 86_400_000;
    chunk(core, 'inside', [BOUNDARY - day]);
    chunk(core, 'crossing', [BOUNDARY - 9 * day, BOUNDARY - 2 * day]);
    chunk(core, 'outside', [BOUNDARY - 9 * day]);
    chunk(core, 'pending', [BOUNDARY - day], { status: 'pending' });
    chunk(core, 'other-tenant', [BOUNDARY - day], { tenant_key: 'key-b' });
    chunk(core, 'plain', [BOUNDARY - day], { encryption_scope: null, key_version: null });
    chunk(core, 'rewrapped', [BOUNDARY - day]);
    chunk(core, 'deleted-later', [BOUNDARY - day]);
    startSnapshot(core, 'snap-core-db');
    startSnapshot(admin, 'snap-admin-db');
    // After T0: a rewrap moves the object, a chunk is deleted with its index, one is added.
    core
      .prepare(
        "UPDATE log_object_catalog SET object_key='logs-rewrapped/x', key_version=2 WHERE id='rewrapped'"
      )
      .run();
    core.prepare("UPDATE log_object_catalog SET status='deleted' WHERE id='deleted-later'").run();
    core
      .prepare(
        "UPDATE log_chunk_record_index SET status='deleted' WHERE object_catalog_id='deleted-later'"
      )
      .run();
    chunk(core, 'after-boundary', [BOUNDARY + 1]);

    const { recorded } = await prepareAll(['logs.archive_object_bodies']);
    const listed = plans(recorded[0]);
    expect(recorded[0].published).toBe(recorded[0].pages.size);
    expect(listed.map((plan) => plan.context.sourceRowId).sort()).toEqual(
      ['crossing', 'deleted-later', 'inside', 'plain', 'rewrapped'].sort()
    );
    const byId = new Map(listed.map((plan) => [plan.context.sourceRowId, plan]));
    expect(byId.get('rewrapped')).toMatchObject({
      objectKey: 'logs/rewrapped',
      sourceEncoding: 'log_chunk_v1',
      context: { chunkId: 'chk-rewrapped', keyVersion: 1, sourceEncrypted: true },
    });
    expect(byId.get('plain')?.context).toMatchObject({
      sourceEncrypted: false,
      targetEncryptionScope: 'tenant-log-archive',
    });
    expect(byId.get('plain')?.context).not.toHaveProperty('keyVersion');
  });

  it('pages more than 4,096 chunks deterministically across calls', async () => {
    core.exec('BEGIN');
    for (let index = 0; index < 4200; index++)
      chunk(core, `c${String(index).padStart(5, '0')}`, [BOUNDARY - 1000]);
    core.exec('COMMIT');
    startSnapshot(core, 'snap-core-db');
    startSnapshot(admin, 'snap-admin-db');

    const first = await prepareAll(['logs.archive_object_bodies']);
    expect(plans(first.recorded[0])).toHaveLength(4200);
    expect(first.recorded[0].pages.size).toBe(Math.ceil(4200 / 256));
    expect(first.recorded[0].published).toBe(first.recorded[0].pages.size);
    expect(first.calls).toBeGreaterThan(1);
    // Publication runs from a saved cursor, never in the call that wrote the last page.
    expect(first.recorded[0].publishCall).toBeGreaterThan(first.recorded[0].lastWriteCall);
    // The same snapshot yields the same pages again.
    const second = await prepareAll(['logs.archive_object_bodies']);
    expect([...second.recorded[0].pages]).toEqual([...first.recorded[0].pages]);
  }, 30_000);

  it('counts large chunks in SQL and skips long runs of rows the snapshot omits', async () => {
    core.exec('BEGIN');
    // Another tenant's rows sort first; reading past them takes many budgeted slices.
    for (let index = 0; index < 3000; index++)
      chunk(core, `a-other-${String(index).padStart(6, '0')}`, [BOUNDARY - 1000], {
        tenant_key: 'key-b',
      });
    chunk(
      core,
      'z-large',
      Array.from({ length: 2000 }, (_, index) => BOUNDARY - 5000 + index)
    );
    core.exec('COMMIT');
    startSnapshot(core, 'snap-core-db');
    startSnapshot(admin, 'snap-admin-db');

    const { recorded, calls } = await prepareAll(['logs.archive_object_bodies'], context(), 2);
    // Slices that met only omitted rows end at the budget and keep their position.
    expect(calls).toBeGreaterThan(1);
    const listed = plans(recorded[0]);
    expect(listed.map((plan) => plan.context.sourceRowId)).toEqual(['z-large']);
    expect(recorded[0].published).toBe(1);
  }, 30_000);

  it('joins artifacts with their T0 catalog and sensitive detail rows', async () => {
    for (const db of [core]) {
      db.prepare("INSERT INTO object_catalog VALUES ('cat-a',?, 'admin_audit_detail', NULL)").run(
        TENANT
      );
      db.prepare(
        "INSERT INTO object_catalog VALUES ('cat-gone',?, 'admin_audit_detail', NULL)"
      ).run(TENANT);
      db.prepare("INSERT INTO object_catalog VALUES ('cat-b','tenant-b','export', NULL)").run();
      db.prepare(
        "INSERT INTO object_catalog_objects VALUES ('obj-a','cat-a','SENSITIVE_DETAILS','details/a',1,?,10,NULL)"
      ).run(SHA);
      db.prepare(
        "INSERT INTO object_catalog_objects VALUES ('obj-gone','cat-gone','SENSITIVE_DETAILS','details/g',1,?,10,NULL)"
      ).run(SHA);
      db.prepare(
        "INSERT INTO object_catalog_objects VALUES ('obj-b','cat-b','EXPORT_ARTIFACTS','export/b',1,?,10,NULL)"
      ).run(SHA);
      db.prepare(
        "INSERT INTO sensitive_detail_chunk_index VALUES ('cat-a',?, 'admin_audit_detail','details/a','none',0,NULL,NULL,1,?,?,NULL)"
      ).run(TENANT, SHA, BOUNDARY - 1000);
      db.prepare(
        "INSERT INTO sensitive_detail_chunk_index VALUES ('cat-gone',?, 'admin_audit_detail','details/g','none',0,NULL,NULL,1,?,?,NULL)"
      ).run(TENANT, SHA, BOUNDARY - 1000);
    }
    startSnapshot(core, 'snap-core-db');
    startSnapshot(admin, 'snap-admin-db');
    // Deleted after T0: still planned with its T0 rows.
    core.prepare("UPDATE object_catalog SET deleted_at=1 WHERE id='cat-gone'").run();
    core.prepare("DELETE FROM sensitive_detail_chunk_index WHERE catalog_id='cat-gone'").run();

    const { recorded } = await prepareAll(['artifacts.object_catalog_bodies']);
    const listed = plans(recorded[0]);
    expect(listed.map((plan) => [plan.context.sourceRowId, plan.sourceEncoding]).sort()).toEqual([
      ['obj-a', 'sensitive_detail_record_v1'],
      ['obj-gone', 'sensitive_detail_record_v1'],
    ]);
  });

  it('plans held logging payloads only when Admin data is selected', async () => {
    admin
      .prepare("INSERT INTO logging_dlq_items VALUES ('dlq-a',?, 'dlq/a','open')")
      .run(TENANT_KEY);
    admin
      .prepare("INSERT INTO logging_dlq_items VALUES ('dlq-b',?, 'dlq/b','replayed')")
      .run(TENANT_KEY);
    admin
      .prepare("INSERT INTO logging_message_jobs VALUES ('job-a',?, 'jobs/a',?, 'queued')")
      .run(TENANT_KEY, SHA);
    startSnapshot(core, 'snap-core-db');
    startSnapshot(admin, 'snap-admin-db');
    const selected = await prepareAll(['logs.archive_object_bodies']);
    expect(plans(selected.recorded[0]).map((plan) => plan.context.sourceRowId)).toEqual([
      'held-dlq.dlq-a',
      'held-message.job-a',
    ]);
    const unselected = await prepareAll(['logs.archive_object_bodies'], context({ admin: false }));
    expect(plans(unselected.recorded[0])).toEqual([]);
    expect(unselected.recorded[0].published).toBe(0);
  });

  it('stops as too large when the lookup tables changed too much since T0', async () => {
    chunk(core, 'a', [BOUNDARY - 1000]);
    core.exec('BEGIN');
    for (let index = 0; index < 5001; index++)
      core
        .prepare('INSERT INTO log_chunk_record_index VALUES (?,?,?,?,?,?,?,?)')
        .run(
          `noise-${index}`,
          TENANT_KEY,
          'audit',
          'archive',
          'noise',
          'chk-noise',
          1,
          'committed'
        );
    core.exec('COMMIT');
    startSnapshot(core, 'snap-core-db');
    startSnapshot(admin, 'snap-admin-db');
    core
      .prepare("UPDATE log_chunk_record_index SET status='deleted' WHERE object_catalog_id='noise'")
      .run();
    await expect(prepareAll(['logs.archive_object_bodies'])).rejects.toThrow(
      'backup_export_too_large'
    );
  });
});
