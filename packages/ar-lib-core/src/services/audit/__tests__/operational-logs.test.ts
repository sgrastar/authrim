import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../object-catalog', async () => await import('../../object-catalog.ts'));
vi.mock(
  '../../object-artifact-crypto',
  async () => await import('../../object-artifact-crypto.ts')
);

import {
  createRuntimeLoggingPolicySnapshot,
  publishRuntimeLoggingPolicySnapshot,
} from '@authrim/ar-lib-logging/policies';
import { getOperationalLog, storeOperationalLog } from '../operational-logs.ts';

interface StoredObject {
  body: Uint8Array;
  contentType?: string;
}

function createMockBucket(initial: Record<string, StoredObject> = {}) {
  const store = new Map<string, StoredObject>(Object.entries(initial));
  return {
    store,
    bucket: {
      put: vi.fn(
        async (
          key: string,
          value: ArrayBuffer | ArrayBufferView | string,
          options?: { httpMetadata?: { contentType?: string } }
        ) => {
          const body =
            typeof value === 'string'
              ? new TextEncoder().encode(value)
              : value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : value instanceof Uint8Array
                  ? value
                  : new Uint8Array(
                      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
                    );
          store.set(key, {
            body,
            contentType: options?.httpMetadata?.contentType,
          });
        }
      ),
      get: vi.fn(async (key: string) => {
        const object = store.get(key);
        if (!object) {
          return null;
        }
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(object.body);
              controller.close();
            },
          }),
          size: object.body.byteLength,
          text: async () => new TextDecoder().decode(object.body),
          writeHttpMetadata(headers: Headers) {
            if (object.contentType) {
              headers.set('Content-Type', object.contentType);
            }
          },
        };
      }),
    } as unknown as R2Bucket,
  };
}

describe('operational-logs', () => {
  const dbState = {
    operationalLogs: [] as Array<Record<string, unknown>>,
    objectCatalog: [] as Array<Record<string, unknown>>,
    objectCatalogObjects: [] as Array<Record<string, unknown>>,
    sensitiveDetailChunkIndex: [] as Array<Record<string, unknown>>,
  };

  const adapter = {
    execute: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO object_catalog_objects')) {
        dbState.objectCatalogObjects.push({
          id: params[0],
          catalog_id: params[1],
          representation: params[2],
          object_kind: params[3],
          object_index: params[4],
          bucket_binding: params[5],
          object_key: params[6],
          key_version: params[7],
          checksum_sha256: params[8],
          total_bytes: params[9],
          created_at: params[10],
          deleted_at: null,
        });
        return { rowsAffected: 1 };
      }
      if (sql.includes('INSERT INTO object_catalog')) {
        dbState.objectCatalog.push({
          id: params[0],
          public_artifact_id: params[1],
          tenant_id: params[2],
          object_class: params[3],
          created_at: params[4],
          updated_at: params[5],
          deleted_at: null,
        });
        return { rowsAffected: 1 };
      }
      if (sql.includes('INSERT INTO sensitive_detail_chunk_index')) {
        dbState.sensitiveDetailChunkIndex.push({
          catalog_id: params[0],
          tenant_id: params[1],
          object_class: params[2],
          bucket_binding: params[3],
          object_key: params[4],
          content_encoding: params[5],
          line_number: params[6],
          key_version: params[7],
          checksum_sha256: params[8],
          created_at: params[9],
          deleted_at: params[10],
        });
        return { rowsAffected: 1 };
      }
      if (sql.includes('INSERT INTO operational_logs')) {
        dbState.operationalLogs.push({
          id: params[0],
          tenant_id: params[1],
          subject_type: params[2],
          subject_id: params[3],
          actor_id: params[4],
          action: params[5],
          reason_detail_encrypted: params[6],
          encryption_key_version: params[7],
          detail_object_catalog_id: params[8],
          request_id: params[9],
          created_at: params[10],
          expires_at: params[11],
        });
        return { rowsAffected: 1 };
      }
      return { rowsAffected: 0 };
    }),
    queryOne: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT * FROM operational_logs')) {
        const now = params[2] as number;
        return (
          dbState.operationalLogs.find(
            (row) =>
              row.id === params[0] && row.tenant_id === params[1] && Number(row.expires_at) > now
          ) ?? null
        );
      }
      if (sql.includes('FROM sensitive_detail_chunk_index')) {
        return (
          dbState.sensitiveDetailChunkIndex.find(
            (row) =>
              row.catalog_id === params[0] &&
              row.tenant_id === params[1] &&
              row.object_class === params[2] &&
              row.deleted_at === null
          ) ?? null
        );
      }
      if (sql.includes('FROM object_catalog oc')) {
        const logical = dbState.objectCatalog.find(
          (row) => row.tenant_id === params[0] && row.id === params[1] && row.deleted_at === null
        );
        const physical = dbState.objectCatalogObjects.find(
          (row) =>
            row.catalog_id === params[1] &&
            row.representation === params[2] &&
            row.object_index === params[3] &&
            row.deleted_at === null
        );
        if (!logical || !physical) {
          return null;
        }
        return {
          catalog_id: logical.id,
          public_artifact_id: logical.public_artifact_id,
          tenant_id: logical.tenant_id,
          object_class: logical.object_class,
          catalog_created_at: logical.created_at,
          catalog_updated_at: logical.updated_at,
          catalog_deleted_at: logical.deleted_at,
          physical_id: physical.id,
          representation: physical.representation,
          object_kind: physical.object_kind,
          object_index: physical.object_index,
          bucket_binding: physical.bucket_binding,
          object_key: physical.object_key,
          key_version: physical.key_version,
          checksum_sha256: physical.checksum_sha256,
          total_bytes: physical.total_bytes,
          physical_created_at: physical.created_at,
          physical_deleted_at: physical.deleted_at,
        };
      }
      return null;
    }),
    query: vi.fn(async () => []),
    batch: vi.fn(async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      for (const statement of statements) {
        await adapter.execute(statement.sql, statement.params ?? []);
      }
      return statements.map(() => ({ rowsAffected: 1, success: true }));
    }),
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(adapter)),
    isHealthy: vi.fn(async () => ({ healthy: true, latencyMs: 0, type: 'mock' })),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => {}),
  };

  const objectRootKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const piiKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.operationalLogs.length = 0;
    dbState.objectCatalog.length = 0;
    dbState.objectCatalogObjects.length = 0;
    dbState.sensitiveDetailChunkIndex.length = 0;
  });

  it('externalizes reason_detail into SENSITIVE_DETAILS when object storage is configured', async () => {
    const objectStore = createMockBucket();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };

    const logId = await storeOperationalLog(
      adapter as any,
      {
        inlineEncryptionKey: piiKey,
        objectStorage: {
          bucket: objectStore.bucket,
          rootKeyHex: objectRootKey,
          keyVersion: 4,
          queueBindings: {
            LOGGING_DELIVERY_CRITICAL_QUEUE: queue,
          },
        },
      },
      {
        tenantId: 'tenant-a',
        subjectType: 'user',
        subjectId: 'user-1',
        actorId: 'admin-1',
        action: 'user.lock',
        reasonDetail: 'Investigation detail',
        requestId: 'req-1',
        retentionDays: 7,
      }
    );

    expect(logId).toBeTruthy();
    expect(dbState.objectCatalog).toHaveLength(1);
    expect(dbState.objectCatalogObjects).toHaveLength(0);
    expect(dbState.sensitiveDetailChunkIndex).toHaveLength(0);
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'chunk_write',
        plane: 'sensitive_detail',
        records: [expect.objectContaining({ tenant_id: 'tenant-a' })],
      })
    );

    const row = dbState.operationalLogs[0];
    expect(row.reason_detail_encrypted).toBeNull();
    expect(row.encryption_key_version).toBe(0);
    expect(typeof row.detail_object_catalog_id).toBe('string');
  });

  it('falls back to inline encrypted storage when object storage is unavailable', async () => {
    const logId = await storeOperationalLog(adapter as any, piiKey, {
      tenantId: 'tenant-a',
      subjectType: 'user',
      subjectId: 'user-2',
      actorId: 'admin-2',
      action: 'user.suspend',
      reasonDetail: 'Inline detail',
      requestId: 'req-2',
    });

    const row = dbState.operationalLogs[0];
    expect(typeof row.reason_detail_encrypted).toBe('string');
    expect(row.detail_object_catalog_id).toBeNull();

    const loaded = await getOperationalLog(adapter as any, piiKey, 'tenant-a', logId);
    expect(loaded?.reason_detail).toBe('Inline detail');
    expect(loaded?.detail_object_catalog_id).toBeNull();
  });

  it('emits metadata-only operational runtime archive records when configured', async () => {
    const objectStore = createMockBucket();
    const kvValues = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string) => kvValues.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kvValues.set(key, value);
      }),
    } as unknown as KVNamespace;
    const queue = { send: vi.fn(async () => {}) };
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      version: 1,
      snapshotId: 'snap_operational_archive',
      synchronizedAt: 1_700_000_000_000,
      sourceUpdatedAt: 1_700_000_000_000,
      policies: {
        assignments: [
          {
            id: 'lpa_operational_archive',
            tenant_id: 'tenant-a',
            log_type: 'operational',
            plane: 'archive',
            destination_id: 'dest_operational_archive',
            enabled: 1,
            managed_by: 'tenant',
            lane: 'default',
            version: 1,
          },
        ],
        fallbacks: [],
        destinations: [
          {
            id: 'dest_operational_archive',
            scope_type: 'shared',
            scope_id: null,
            destination_kind: 'object_storage',
            provider: 'r2',
            name: 'operational-archive',
            display_name: 'Operational Archive',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({
              bindingRef: 'DIAGNOSTIC_LOGS',
              prefix: 'operational-runtime',
            }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['operational']),
            allowed_planes: JSON.stringify(['archive']),
            region: null,
            critical_allowed: 0,
            default_fallback_eligible: 1,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
        ],
      },
    });
    await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv,
      objectStore: objectStore.bucket,
      now: 1_700_000_000_000,
    });

    const logId = await storeOperationalLog(
      adapter as any,
      {
        inlineEncryptionKey: piiKey,
        runtimeLogging: {
          env: {
            DB_ADMIN: adapter as never,
            AUTHRIM_CONFIG: kv,
            DIAGNOSTIC_LOGS: objectStore.bucket,
            OBJECT_ENCRYPTION_ROOT_KEY: objectRootKey,
            LOGGING_DELIVERY_QUEUE: queue as never,
          },
          tenantKeyResolver: async () => 't_operational_runtime',
        },
      },
      {
        tenantId: 'tenant-a',
        subjectType: 'user',
        subjectId: 'user-3',
        actorId: 'admin-3',
        action: 'user.activate',
        reasonDetail: 'Runtime detail must stay out of archive metadata',
        requestId: 'req-3',
      }
    );

    const runtimeObjectKey = [...objectStore.store.keys()].find((key) =>
      key.includes('operational-runtime/')
    );
    expect(logId).toBeTruthy();
    expect(runtimeObjectKey).toBeTruthy();
    expect(runtimeObjectKey).toContain('/t_operational_runtime/');
    expect(runtimeObjectKey).not.toContain('/tenant-a/');
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'delivery_fanout',
        destination_id: 'dest_operational_archive',
        log_type: 'operational',
        plane: 'archive',
      })
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.any(Array)
    );
    expect(JSON.stringify(adapter.execute.mock.calls)).not.toContain(
      'Runtime detail must stay out of archive metadata'
    );
  });
});
