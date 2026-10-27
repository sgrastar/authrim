import { vi } from 'vitest';
import { icebergFixture } from './log-iceberg-test-fixture';
import { createLogIcebergWritePort, type LogIcebergRuntimeEnv } from '../log-iceberg-runtime';
import { decryptLogIcebergRecord } from '../log-iceberg-record';
import { decodeLogIcebergRow } from '../log-iceberg-row-codec';
import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { SqlLogIcebergRecordStore } from '../log-iceberg-store';
import type { DatabaseAdapter } from '../../db';
import type { CoreLogPublicationSource } from '../log-iceberg-core-publication';

vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));

/** Real SQLite and crypto; only Cloudflare transport bindings are in-memory test doubles. */
export async function logProducerFixture(
  mode: 'scheduled' | 'pipeline',
  options: {
    separateAdmin?: boolean;
    corePublicationAdapter?: DatabaseAdapter;
    tenantId?: string;
  } = {}
) {
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
  const objects = new Map<string, { text: string; metadata: Record<string, string> }>();
  const queueMessages: unknown[] = [];
  const streamRecords: LogArchiveRecord[] = [];
  const bucket = {
    async head(key: string) {
      const value = objects.get(key);
      return value
        ? {
            size: new TextEncoder().encode(value.text).byteLength,
            customMetadata: value.metadata,
            etag: key,
          }
        : null;
    },
    async put(key: string, value: string, options?: { customMetadata?: Record<string, string> }) {
      if (objects.has(key)) return null;
      objects.set(key, { text: value, metadata: options?.customMetadata ?? {} });
      return { key };
    },
    async get(key: string) {
      const value = objects.get(key);
      if (!value) return null;
      const bytes = new TextEncoder().encode(value.text);
      return {
        size: bytes.length,
        customMetadata: value.metadata,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as unknown as R2Bucket;
  const publicationSource: CoreLogPublicationSource = {
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
  const env: LogIcebergRuntimeEnv = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL: {
      acquireTenantBackupMutationPermit: async () => ({ admitted: true }),
      completeTenantBackupMutationPermit: async () => ({ completed: true }),
    } as unknown as NonNullable<LogIcebergRuntimeEnv['CONTROL']>,
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
      send: async (value: unknown) => {
        queueMessages.push(value);
      },
    } as LogIcebergRuntimeEnv['LOGGING_DELIVERY_QUEUE'],
    LOG_ARCHIVE_STREAM: {
      send: async (records: LogArchiveRecord[]) => {
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
  const rows = async (sourceDataset: string, tenantId = defaultTenant) => {
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
            .map(
              (row) => JSON.parse(objects.get(String(row.payload_key))!.text) as LogArchiveRecord
            );
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
