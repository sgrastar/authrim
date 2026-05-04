import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

interface StoredObject {
  body: Uint8Array;
  contentType?: string;
}

const {
  mockRequireAdminDatabaseAdapter,
  mockGetTenantIdFromContext,
  mockGetLogger,
  mockAdapter,
  dbState,
} = vi.hoisted(() => {
  const state = {
    objectCatalog: [] as Array<Record<string, unknown>>,
    objectCatalogObjects: [] as Array<Record<string, unknown>>,
    adminAuditLogs: [] as Array<Record<string, unknown>>,
  };

  const adapter = {
    execute: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO object_catalog_objects')) {
        state.objectCatalogObjects.push({
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
      } else if (sql.includes('INSERT INTO object_catalog')) {
        state.objectCatalog.push({
          id: params[0],
          public_artifact_id: params[1],
          tenant_id: params[2],
          object_class: params[3],
          created_at: params[4],
          updated_at: params[5],
          deleted_at: null,
        });
      } else if (sql.includes('INSERT INTO admin_audit_log')) {
        state.adminAuditLogs.push({
          id: params[0],
          tenant_id: params[1],
          admin_user_id: params[2],
          admin_email: params[3],
          action: params[4],
          resource_type: params[5],
          resource_id: params[6],
          result: params[7],
          error_code: params[8],
          error_message: params[9],
          severity: params[10],
          ip_address: params[11],
          user_agent: params[12],
          request_id: params[13],
          session_id: params[14],
          before_json: params[15],
          after_json: params[16],
          metadata_json: params[17],
          detail_object_catalog_id: params[18],
          created_at: params[19],
        });
      }
      return { rowsAffected: 1 };
    }),
    queryOne: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT * FROM admin_audit_log WHERE id = ?')) {
        return state.adminAuditLogs.find((row) => row.id === params[0]) ?? null;
      }

      if (sql.includes('FROM object_catalog oc')) {
        const catalog = state.objectCatalog.find(
          (row) => row.id === params[0] || row.public_artifact_id === params[0]
        );
        const object = state.objectCatalogObjects.find(
          (row) =>
            row.catalog_id === catalog?.id &&
            row.representation === params[1] &&
            row.object_index === params[2]
        );
        if (!catalog || !object) {
          return null;
        }
        return {
          catalog_id: catalog.id,
          public_artifact_id: catalog.public_artifact_id,
          tenant_id: catalog.tenant_id,
          object_class: catalog.object_class,
          catalog_created_at: catalog.created_at,
          catalog_updated_at: catalog.updated_at,
          catalog_deleted_at: catalog.deleted_at,
          physical_id: object.id,
          representation: object.representation,
          object_kind: object.object_kind,
          object_index: object.object_index,
          bucket_binding: object.bucket_binding,
          object_key: object.object_key,
          key_version: object.key_version,
          checksum_sha256: object.checksum_sha256,
          total_bytes: object.total_bytes,
          physical_created_at: object.created_at,
          physical_deleted_at: object.deleted_at,
        };
      }

      return null;
    }),
    query: vi.fn(async () => []),
    transaction: vi.fn(async (fn: (tx: typeof adapter) => Promise<unknown>) => fn(adapter)),
    batch: vi.fn(async () => []),
    isHealthy: vi.fn(async () => true),
    getType: vi.fn(() => 'd1' as const),
    close: vi.fn(async () => {}),
  };

  return {
    mockRequireAdminDatabaseAdapter: vi.fn(() => adapter),
    mockGetTenantIdFromContext: vi.fn(() => 'tenant-1'),
    mockGetLogger: vi.fn(() => ({
      module: () => ({
        error: vi.fn(),
      }),
    })),
    mockAdapter: adapter,
    dbState: state,
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminDatabaseAdapter: mockRequireAdminDatabaseAdapter,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    getLogger: mockGetLogger,
    loadCatalogObjectJson: actual.loadCatalogObjectJson,
  };
});

import { loadAdminAuditDetail, writeAdminAuditLog } from '../admin-shared';

const OBJECT_ROOT_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

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

function createMockContext(envOverrides: Partial<Env> = {}) {
  const objectStore = createMockBucket();
  const contextStore = new Map<string, unknown>();
  const env = {
    SENSITIVE_DETAILS: objectStore.bucket,
    OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
    OBJECT_ENCRYPTION_KEY_VERSION: '3',
    ...envOverrides,
  } as Env;

  const c = {
    env,
    req: {
      header(name: string) {
        if (name === 'CF-Connecting-IP') return '203.0.113.9';
        if (name === 'User-Agent') return 'VitestAgent/1.0';
        return undefined;
      },
    },
    get(key: string) {
      return contextStore.get(key);
    },
    set(key: string, value: unknown) {
      contextStore.set(key, value);
    },
  } as unknown as Parameters<typeof writeAdminAuditLog>[0];

  (c as any).set('adminAuth', {
    userId: 'admin-1',
    email: 'admin@example.com',
    sessionId: 'sess-1',
  });

  return {
    c,
    objectStore,
  };
}

describe('admin-shared audit detail externalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.objectCatalog.length = 0;
    dbState.objectCatalogObjects.length = 0;
    dbState.adminAuditLogs.length = 0;
  });

  it('externalizes admin audit detail into SENSITIVE_DETAILS when object storage is available', async () => {
    const { c, objectStore } = createMockContext();

    await writeAdminAuditLog(c, {
      action: 'admin.role.updated',
      resourceType: 'admin_role',
      resourceId: 'role-1',
      result: 'success',
      metadata: { ticket: 'CASE-123', diff: ['name'] },
      before: { display_name: 'Old Name' },
      after: { display_name: 'New Name' },
    });

    expect(dbState.objectCatalog).toHaveLength(1);
    expect(dbState.objectCatalogObjects).toHaveLength(1);
    expect(dbState.adminAuditLogs).toHaveLength(1);
    expect(objectStore.store.size).toBe(1);

    const logRow = dbState.adminAuditLogs[0];
    expect(logRow.before_json).toBeNull();
    expect(logRow.after_json).toBeNull();
    expect(logRow.metadata_json).toBeNull();
    expect(typeof logRow.detail_object_catalog_id).toBe('string');
    const detailCatalog = dbState.objectCatalog[0];
    expect(detailCatalog.public_artifact_id).toMatch(/^oa_/);

    const detail = await loadAdminAuditDetail(
      c,
      mockAdapter as unknown as import('@authrim/ar-lib-core').DatabaseAdapter,
      'tenant-1',
      detailCatalog.public_artifact_id as string,
      logRow.detail_object_catalog_id as string
    );
    expect(detail).toEqual({
      before: { display_name: 'Old Name' },
      after: { display_name: 'New Name' },
      metadata: { ticket: 'CASE-123', diff: ['name'] },
    });
  });

  it('falls back to inline JSON when encrypted object storage is unavailable', async () => {
    const { c } = createMockContext({
      SENSITIVE_DETAILS: undefined,
      OBJECT_ENCRYPTION_ROOT_KEY: undefined,
    });

    await writeAdminAuditLog(c, {
      action: 'admin.user.created',
      resourceType: 'admin_user',
      resourceId: 'admin-2',
      result: 'success',
      metadata: { invite: true },
      after: { email: 'new-admin@example.com' },
    });

    expect(dbState.objectCatalog).toHaveLength(0);
    expect(dbState.objectCatalogObjects).toHaveLength(0);
    expect(dbState.adminAuditLogs).toHaveLength(1);

    const logRow = dbState.adminAuditLogs[0];
    expect(logRow.detail_object_catalog_id).toBeNull();
    expect(logRow.before_json).toBeNull();
    expect(logRow.after_json).toBe(JSON.stringify({ email: 'new-admin@example.com' }));
    expect(logRow.metadata_json).toBe(JSON.stringify({ invite: true }));
  });
});
