import { vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { renderPortableMigrationSql } from '../../packages/ar-lib-core/dist/migrations/sql-portability';
import { createLogIcebergWritePort } from '../../packages/ar-lib-core/dist/services/log-iceberg-runtime.js';
import { decryptLogIcebergRecord } from '../../packages/ar-lib-core/dist/services/log-iceberg-record.js';
import { decodeLogIcebergRow } from '../../packages/ar-lib-core/dist/services/log-iceberg-row-codec.js';
function sqliteAdapter(plane = 'core') {
  const db = new DatabaseSync(':memory:');
  const folder = new URL(`../../migrations/${plane}/d1/`, import.meta.url);
  for (const file of readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    db.exec(renderPortableMigrationSql(readFileSync(new URL(file, folder), 'utf8'), 'sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  const values = (p = []) => p.map((v) => (v === undefined ? null : v));
  const execute = async (sql, params) => ({
    success: true,
    rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
  });
  const adapter = {
    query: async (sql, params) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql, params) => db.prepare(sql).get(...values(params)) ?? null,
    execute,
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const statement of statements)
          out.push(await execute(statement.sql, statement.params));
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    transaction: async () => {
      throw new Error('Use atomic batch');
    },
    getType: () => 'd1',
    close: async () => {},
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
  };
  return { db, adapter };
}
async function icebergFixture() {
  const f = sqliteAdapter();
  f.db.exec(
    readFileSync(
      new URL('../../migrations/admin/d1/052_log_iceberg_storage.sql', import.meta.url),
      'utf8'
    )
  );
  f.db.exec(
    'CREATE TABLE IF NOT EXISTS scheduled_task_leases(task_id TEXT NOT NULL PRIMARY KEY,lease_token TEXT NOT NULL,lease_until INTEGER NOT NULL,updated_at INTEGER NOT NULL)'
  );
  const now = Date.now();
  const config = {
    mode: 'scheduled',
    generation: 'new-generation',
    schemaVersion: 1,
    activatedAt: now - 30 * 86400000,
    accountId: 'a'.repeat(32),
    bucket: 'authrim-test',
    warehouse: `${'a'.repeat(32)}_authrim-test`,
    catalogUri: `https://catalog.cloudflarestorage.com/${'a'.repeat(32)}/authrim-test`,
    namespace: 'authrim',
    table: 'logs_v1',
    tableUuid: 'bba2d8f7-861e-4b6e-9df1-48faea8ae805',
    physicalFingerprint: 'a'.repeat(64),
    dbRetentionDays: 7,
    exportIntervalMinutes: 10,
  };
  return {
    ...f,
    now,
    config,
    keys: { rootKeyHex: 'ab'.repeat(32), contentHmacKeyHex: 'cd'.repeat(32), keyVersion: 1 },
  };
}
import { SqlLogIcebergRecordStore } from '../../packages/ar-lib-core/dist/services/log-iceberg-store.js';
vi.mock('../../packages/ar-lib-logging/dist/iceberg/capabilities.js', async (original) => ({
  ...(await original()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));
/** Real SQLite and crypto; only Cloudflare transport bindings are in-memory test doubles. */
export async function logProducerFixture(mode, options = {}) {
  const f = await icebergFixture();
  const admin = options.separateAdmin ? sqliteAdapter('admin') : { db: f.db, adapter: f.adapter };
  const staging = new SqlLogIcebergRecordStore(admin.adapter);
  Object.assign(f.adapter, {
    getType: () => 'd1',
    close: async () => {},
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
    transaction: async () => {
      throw new Error('Use atomic batch');
    },
  });
  if (options.separateAdmin)
    Object.assign(admin.adapter, {
      getType: () => 'd1',
      close: async () => {},
      isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
      transaction: async () => {
        throw new Error('Use atomic batch');
      },
    });
  for (const [id, key] of [
    ['tenant-a', 'key-a'],
    ['tenant-b', 'key-b'],
  ])
    f.db
      .prepare(
        'INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at) VALUES(?,?,?,?,?,?)'
      )
      .run(id, id, key, id, f.now, f.now);
  const defaultTenant = options.tenantId ?? 'tenant-a';
  if (!['tenant-a', 'tenant-b'].includes(defaultTenant))
    f.db
      .prepare(
        'INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tenant_key=excluded.tenant_key'
      )
      .run(
        defaultTenant,
        `test-${defaultTenant}`,
        `key-${defaultTenant}`,
        defaultTenant,
        f.now,
        f.now
      );
  const config = {
    ...f.config,
    mode,
    dbRetentionDays: mode === 'scheduled' ? 7 : null,
    exportIntervalMinutes: mode === 'scheduled' ? 10 : null,
  };
  const objects = new Map();
  const queueMessages = [];
  const streamRecords = [];
  const bucket = {
    async head(key) {
      const value = objects.get(key);
      return value
        ? {
            size: new TextEncoder().encode(value.text).byteLength,
            customMetadata: value.metadata,
            etag: key,
          }
        : null;
    },
    async put(key, value, options) {
      if (objects.has(key)) return null;
      objects.set(key, { text: value, metadata: options?.customMetadata ?? {} });
      return { key };
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      const bytes = new TextEncoder().encode(value.text);
      return {
        size: bytes.length,
        customMetadata: value.metadata,
        body: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  const publicationSource = {
    environmentId: 'test',
    tenantId: defaultTenant,
    bindingRef: 'DB',
    databaseId: 'source-db',
    provider: 'd1',
    generation: 1,
    bindingRouteGeneration: 1,
    dataRole: 'tenant_core/default',
    residencyPartition: 'default',
    shardId: 'default',
    shardGroup: 'default',
    shardIndex: 0,
  };
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL: {
      acquireTenantBackupMutationPermit: async () => ({ admitted: true }),
      completeTenantBackupMutationPermit: async () => ({ completed: true }),
    },
    DB: f.adapter,
    DB_ADMIN: admin.adapter,
    AUTHRIM_LOG_ARCHIVE_MODE: mode,
    AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: config.generation,
    AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: '1',
    AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: new Date(config.activatedAt).toISOString(),
    AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID: config.accountId,
    AUTHRIM_LOG_ARCHIVE_BUCKET: config.bucket,
    AUTHRIM_LOG_ARCHIVE_CATALOG_URI: config.catalogUri,
    AUTHRIM_LOG_ARCHIVE_WAREHOUSE: config.warehouse,
    AUTHRIM_LOG_ARCHIVE_NAMESPACE: config.namespace,
    AUTHRIM_LOG_ARCHIVE_TABLE: config.table,
    AUTHRIM_LOG_ARCHIVE_TABLE_UUID: config.tableUuid,
    AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: config.physicalFingerprint,
    ...(mode === 'scheduled'
      ? {
          AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: '7',
          AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: '10',
        }
      : {}),
    OBJECT_ENCRYPTION_ROOT_KEY: f.keys.rootKeyHex,
    LOG_ARCHIVE_CONTENT_HMAC_KEY: f.keys.contentHmacKeyHex,
    LOG_ARCHIVE_ROOT_KEYRING: JSON.stringify({
      schema_version: 1,
      current_version: 1,
      roots: { 1: f.keys.rootKeyHex },
    }),
    LOG_ARCHIVE: bucket,
    LOGGING_DELIVERY_QUEUE: {
      send: async (value) => {
        queueMessages.push(value);
      },
    },
    LOG_ARCHIVE_STREAM: {
      send: async (records) => {
        streamRecords.push(...records);
      },
    },
  };
  env.LOG_ARCHIVE_WRITER = createLogIcebergWritePort(env, config, Date.now, {
    resolveCorePublicationSource: async (source) => {
      if (
        source.tenantId !== publicationSource.tenantId ||
        source.databaseId !== publicationSource.databaseId
      )
        throw new Error('test_source_mismatch');
      return options.corePublicationAdapter ?? f.adapter;
    },
  });
  const rows = async (sourceDataset, tenantId = defaultTenant) => {
    const tenantKey = String(
      f.db.prepare('SELECT tenant_key FROM tenants WHERE id=?').get(tenantId)?.tenant_key
    );
    const records =
      mode === 'scheduled'
        ? await staging.readTenant({ tenantId, tenantKey, sourceDataset, now: f.now })
        : admin.db
            .prepare(
              "SELECT payload_key FROM log_iceberg_outbox WHERE tenant_id=? AND source_dataset=? AND state IN('pending','queued','ingested') ORDER BY id"
            )
            .all(tenantId, sourceDataset)
            .map((row) => JSON.parse(objects.get(String(row.payload_key)).text));
    return Promise.all(
      records.map(async (record) =>
        decodeLogIcebergRow(
          await decryptLogIcebergRecord(record, { tenantKey, sourceDataset }, async () => f.keys),
          tenantId,
          record.event_id
        )
      )
    );
  };
  return {
    ...f,
    staging,
    adminDb: admin.db,
    adminAdapter: admin.adapter,
    close: () => {
      f.db.close();
      if (options.separateAdmin) admin.db.close();
    },
    config,
    env,
    publicationSource,
    objects,
    queueMessages,
    streamRecords,
    rows,
  };
}

import { applyUpdates, checkRequirements } from 'icebird/src/write/commit.js';
import {
  LOG_ARCHIVE_ICEBERG_SCHEMA,
  logArchivePhysicalFingerprint,
  IcebergCatalogConflictError,
} from '../../packages/ar-lib-logging/dist/iceberg/index.js';
import { buildLogIcebergRecord } from '../../packages/ar-lib-core/dist/services/log-iceberg-record.js';
import { encodeLogIcebergRow } from '../../packages/ar-lib-core/dist/services/log-iceberg-row-codec.js';
/** Shared JS-only fixture keeps consuming packages inside their TypeScript rootDir. */
export function icebergSnapshotMetadata(pipeline = false) {
  const metadata = {
    'format-version': 2,
    'table-uuid': 'bba2d8f7-861e-4b6e-9df1-48faea8ae805',
    location: 's3://authrim-test/logs/events',
    'last-sequence-number': 0,
    'last-updated-ms': 1793000000000,
    'last-column-id': 20,
    'current-schema-id': 0,
    schemas: [structuredClone(LOG_ARCHIVE_ICEBERG_SCHEMA)],
    'default-spec-id': 0,
    'partition-specs': [{ 'spec-id': 0, fields: [] }],
    'last-partition-id': 999,
    'sort-orders': [{ 'order-id': 0, fields: [] }],
    'default-sort-order-id': 0,
  };
  if (pipeline) {
    const provider = { id: 1, name: '__ingest_ts', type: 'timestamptz', required: false };
    metadata.schemas[0].fields = [
      provider,
      ...metadata.schemas[0].fields.map((f) => ({ ...f, id: f.id + 1, required: false })),
    ];
    metadata.schemas[0]['identifier-field-ids'] = [];
    metadata['last-column-id'] = 21;
    metadata['partition-specs'] = [
      {
        'spec-id': 0,
        fields: [{ 'source-id': 1, 'field-id': 1000, name: '__ingest_ts_day', transform: 'day' }],
      },
    ];
  }
  return metadata;
}
export function icebergSnapshotCoreFixture() {
  return sqliteAdapter();
}
export async function icebergSnapshotFixture() {
  const f = await icebergFixture();
  const catalog = {
    metadata: icebergSnapshotMetadata(),
    beforeCommit: undefined,
    afterCommit: undefined,
    async loadTable() {
      return {
        metadata: structuredClone(this.metadata),
        metadataLocation: this.metadata.location + '/metadata/catalog.json',
      };
    },
    async commit(update) {
      if (this.beforeCommit) await this.beforeCommit();
      try {
        checkRequirements(this.metadata, update.requirements);
      } catch {
        throw new IcebergCatalogConflictError('CAS conflict');
      }
      this.metadata = applyUpdates(
        this.metadata,
        update.updates.filter((u) => u.action !== 'remove-snapshot-ref')
      );
      for (const u of update.updates)
        if (u.action === 'remove-snapshot-ref' && this.metadata.refs)
          delete this.metadata.refs[u['ref-name']];
      if (this.afterCommit) await this.afterCommit();
      return this.loadTable();
    },
  };
  const objects = new Map();
  const store = {
    objects,
    async size(path) {
      const o = objects.get(path);
      if (!o) throw Error('missing');
      return o.bytes.length;
    },
    async readRange(path, offset, length) {
      const o = objects.get(path);
      if (!o || offset < 0 || length < 0 || offset + length > o.bytes.length) throw Error('range');
      return Uint8Array.from(o.bytes.subarray(offset, offset + length));
    },
    async read(path, maximum) {
      const o = objects.get(path);
      if (!o || o.bytes.length > maximum) throw Error('fixture missing or over bound');
      return Uint8Array.from(o.bytes);
    },
    async putImmutable(path, bytes, identity) {
      const previous = objects.get(path);
      if (previous && (previous.identity !== identity || previous.bytes.length !== bytes.length))
        throw Error('immutable conflict');
      if (!previous) objects.set(path, { bytes: Uint8Array.from(bytes), identity });
    },
  };
  f.config.physicalFingerprint = await logArchivePhysicalFingerprint(catalog.metadata);
  const staging = new SqlLogIcebergRecordStore(f.adapter);
  const record = async (id = 'event-1', options = {}) => {
    const tenantId = options.tenantId ?? 'tenant-a',
      tenantKey = options.tenantKey ?? 'key-a',
      sourceDataset = options.sourceDataset ?? 'core.audit_log';
    const body = await encodeLogIcebergRow({
      context: {
        tenantKey,
        sourceDataset,
        eventId: id,
        generation: f.config.generation,
        schemaVersion: 1,
      },
      row: {
        id,
        tenant_id: tenantId,
        action: 'user.login',
        created_at: Math.floor((f.now - 8 * 86400000) / 1000),
        metadata_json: '{"email":"private@example.invalid"}',
        ...options.row,
      },
      keys: f.keys,
      ...(options.protectedDetail ? { protectedDetail: options.protectedDetail } : {}),
    });
    return buildLogIcebergRecord(
      f.config,
      {
        eventId: id,
        tenantKey,
        sourceDataset,
        logType: options.logType ?? 'audit',
        eventAt: f.now - 8 * 86400000,
        ingestedAt: f.now - 8 * 86400000,
        expiresAt: options.expiresAt === undefined ? f.now + 86400000 : options.expiresAt,
        overview: {
          subject_id:
            sourceDataset === 'pii.pii_log'
              ? (options.subjectId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
              : null,
        },
        body,
      },
      f.keys
    );
  };
  return { ...f, catalog, store, record, staging };
}
