import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../object-catalog', async () => await import('../../object-catalog.ts'));
vi.mock(
  '../../object-artifact-crypto',
  async () => await import('../../object-artifact-crypto.ts')
);

import {
  getOperationalLog,
  storeOperationalLog,
} from '../operational-logs.ts';

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
            (row) => row.id === params[0] && row.tenant_id === params[1] && Number(row.expires_at) > now
          ) ?? null
        );
      }
      if (sql.includes('FROM object_catalog oc')) {
        const logical = dbState.objectCatalog.find(
          (row) => row.id === params[0] && row.deleted_at === null
        );
        const physical = dbState.objectCatalogObjects.find(
          (row) =>
            row.catalog_id === params[0] &&
            row.representation === params[1] &&
            row.object_index === params[2] &&
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
  };

  const objectRootKey =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const piiKey =
    'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.operationalLogs.length = 0;
    dbState.objectCatalog.length = 0;
    dbState.objectCatalogObjects.length = 0;
  });

  it('externalizes reason_detail into SENSITIVE_DETAILS when object storage is configured', async () => {
    const objectStore = createMockBucket();

    const logId = await storeOperationalLog(
      adapter as any,
      {
        inlineEncryptionKey: piiKey,
        objectStorage: {
          bucket: objectStore.bucket,
          rootKeyHex: objectRootKey,
          keyVersion: 4,
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
    expect(dbState.objectCatalogObjects).toHaveLength(1);

    const row = dbState.operationalLogs[0];
    expect(row.reason_detail_encrypted).toBeNull();
    expect(row.encryption_key_version).toBe(0);
    expect(typeof row.detail_object_catalog_id).toBe('string');

    const loaded = await getOperationalLog(
      adapter as any,
      {
        inlineEncryptionKey: piiKey,
        objectStorage: {
          bucket: objectStore.bucket,
          rootKeyHex: objectRootKey,
          keyVersion: 4,
        },
      },
      'tenant-a',
      logId
    );

    expect(loaded?.reason_detail).toBe('Investigation detail');
    expect(loaded?.detail_object_catalog_id).toEqual(row.detail_object_catalog_id);
  });

  it('falls back to inline encrypted storage when object storage is unavailable', async () => {
    const logId = await storeOperationalLog(
      adapter as any,
      piiKey,
      {
        tenantId: 'tenant-a',
        subjectType: 'user',
        subjectId: 'user-2',
        actorId: 'admin-2',
        action: 'user.suspend',
        reasonDetail: 'Inline detail',
        requestId: 'req-2',
      }
    );

    const row = dbState.operationalLogs[0];
    expect(typeof row.reason_detail_encrypted).toBe('string');
    expect(row.detail_object_catalog_id).toBeNull();

    const loaded = await getOperationalLog(adapter as any, piiKey, 'tenant-a', logId);
    expect(loaded?.reason_detail).toBe('Inline detail');
    expect(loaded?.detail_object_catalog_id).toBeNull();
  });
});
