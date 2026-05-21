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
    sensitiveDetailChunkIndex: [] as Array<Record<string, unknown>>,
    adminAuditLogs: [] as Array<Record<string, unknown>>,
  };

  const adapter = {
    execute: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO sensitive_detail_chunk_index')) {
        state.sensitiveDetailChunkIndex.push({
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
      } else if (sql.includes('INSERT INTO object_catalog_objects')) {
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
      if (sql.includes('FROM sensitive_detail_chunk_index')) {
        const catalogId = params[0];
        const tenantId = params[1];
        const objectClass = params[2];
        return (
          state.sensitiveDetailChunkIndex.find(
            (row) =>
              row.catalog_id === catalogId &&
              row.tenant_id === tenantId &&
              row.object_class === objectClass &&
              row.deleted_at == null
          ) ?? null
        );
      }

      if (sql.startsWith('SELECT * FROM admin_audit_log WHERE id = ?')) {
        return state.adminAuditLogs.find((row) => row.id === params[0]) ?? null;
      }

      if (sql.includes('FROM object_catalog oc')) {
        const tenantId = params[0];
        const identifier = params[1];
        const representation = params[2];
        const objectIndex = params[3];
        const catalog = state.objectCatalog.find(
          (row) =>
            row.tenant_id === tenantId &&
            (row.id === identifier || row.public_artifact_id === identifier)
        );
        const object = state.objectCatalogObjects.find(
          (row) =>
            row.catalog_id === catalog?.id &&
            row.representation === representation &&
            row.object_index === objectIndex
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

import { writeAdminAuditLog } from '../admin-shared';

const OBJECT_ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

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

function createMockContext(
  envOverrides: Partial<Env> = {},
  options: {
    headers?: Record<string, string>;
    requestId?: string;
  } = {}
) {
  const objectStore = createMockBucket();
  const loggingQueue = { send: vi.fn().mockResolvedValue(undefined) };
  const contextStore = new Map<string, unknown>();
  const headers = new Map(
    Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  const env = {
    SENSITIVE_DETAILS: objectStore.bucket,
    OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
    OBJECT_ENCRYPTION_KEY_VERSION: '3',
    LOGGING_DELIVERY_CRITICAL_QUEUE: loggingQueue,
    ...envOverrides,
  } as Env;

  const c = {
    env,
    req: {
      header(name: string) {
        const headerValue = headers.get(name.toLowerCase());
        if (headerValue) return headerValue;
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

  if (options.requestId) {
    (c as any).set('requestId', options.requestId);
  }

  (c as any).set('adminAuth', {
    userId: 'admin-1',
    authMethod: 'session',
    email: 'admin@example.com',
    sessionId: 'sess-1',
  });

  return {
    c,
    objectStore,
    loggingQueue,
  };
}

describe('admin-shared audit detail externalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.objectCatalog.length = 0;
    dbState.objectCatalogObjects.length = 0;
    dbState.sensitiveDetailChunkIndex.length = 0;
    dbState.adminAuditLogs.length = 0;
  });

  it('externalizes admin audit detail into SENSITIVE_DETAILS when object storage is available', async () => {
    const { c, objectStore, loggingQueue } = createMockContext();

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
    expect(dbState.objectCatalogObjects).toHaveLength(0);
    expect(dbState.sensitiveDetailChunkIndex).toHaveLength(0);
    expect(dbState.adminAuditLogs).toHaveLength(1);
    expect(objectStore.store.size).toBe(0);
    expect(loggingQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'chunk_write',
        plane: 'sensitive_detail',
        records: [expect.objectContaining({ object_class: 'admin_audit_detail' })],
      })
    );

    const logRow = dbState.adminAuditLogs[0];
    expect(logRow.before_json).toBeNull();
    expect(logRow.after_json).toBeNull();
    expect(JSON.parse(logRow.metadata_json as string)).toEqual({
      admin_actor_type: 'admin_user',
      admin_actor_id: 'admin-1',
      admin_auth_method: 'session',
    });
    expect(typeof logRow.detail_object_catalog_id).toBe('string');
    const detailCatalog = dbState.objectCatalog[0];
    expect(detailCatalog.public_artifact_id).toMatch(/^oa_/);
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
    expect(dbState.sensitiveDetailChunkIndex).toHaveLength(0);
    expect(dbState.adminAuditLogs).toHaveLength(1);

    const logRow = dbState.adminAuditLogs[0];
    expect(logRow.detail_object_catalog_id).toBeNull();
    expect(logRow.before_json).toBeNull();
    expect(logRow.after_json).toBe(JSON.stringify({ email: 'new-admin@example.com' }));
    expect(JSON.parse(logRow.metadata_json as string)).toEqual({
      invite: true,
      admin_actor_type: 'admin_user',
      admin_actor_id: 'admin-1',
      admin_auth_method: 'session',
    });
  });

  it('records request id and Admin UI BFF metadata on admin audit rows', async () => {
    const { c } = createMockContext(
      {
        SENSITIVE_DETAILS: undefined,
        OBJECT_ENCRYPTION_ROOT_KEY: undefined,
      },
      {
        requestId: 'mgmt-req-1',
        headers: {
          'X-Request-Id': 'bff-req-1',
          'X-Correlation-Id': 'corr-1',
          'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
          'X-Authrim-Forwarded-Host': 'api.authrim.example',
          'X-Forwarded-Proto': 'https',
        },
      }
    );

    await writeAdminAuditLog(c, {
      action: 'admin.user.updated',
      resourceType: 'admin_user',
      resourceId: 'admin-1',
      result: 'success',
      metadata: { admin_ui_api_mode: 'spoofed', ticket: 'CASE-456' },
    });

    expect(dbState.adminAuditLogs).toHaveLength(1);

    const logRow = dbState.adminAuditLogs[0];
    expect(logRow.request_id).toBe('mgmt-req-1');
    expect(JSON.parse(logRow.metadata_json as string)).toEqual({
      admin_ui_api_mode: 'cross-site-proxy-bff',
      admin_ui_bff_forwarded_host: 'api.authrim.example',
      admin_ui_bff_forwarded_proto: 'https',
      admin_ui_bff_request_id: 'bff-req-1',
      admin_ui_bff_correlation_id: 'corr-1',
      admin_actor_type: 'admin_user',
      admin_actor_id: 'admin-1',
      admin_auth_method: 'session',
      ticket: 'CASE-456',
    });
  });

  it('records machine actor and credential metadata on admin audit rows', async () => {
    const { c } = createMockContext({
      SENSITIVE_DETAILS: undefined,
      OBJECT_ENCRYPTION_ROOT_KEY: undefined,
    });
    (c as any).set('adminAuth', {
      userId: 'amp_mcp_admin',
      authMethod: 'machine_access_token',
      actorType: 'machine',
      actorId: 'amp_mcp_admin',
      principalType: 'mcp_server',
      credentialId: 'amk_mcp_admin',
      clientId: 'mcp-admin-server',
      clientAuthMethod: 'private_key_jwt',
      credentialStrength: 'asymmetric_key',
      senderConstrained: false,
    });

    await writeAdminAuditLog(c, {
      action: 'ai_grant.created',
      resourceType: 'ai_grant',
      resourceId: 'grant-1',
      result: 'success',
      metadata: { ticket: 'CASE-789' },
    });

    expect(dbState.adminAuditLogs).toHaveLength(1);
    const logRow = dbState.adminAuditLogs[0];
    expect(logRow.admin_user_id).toBeNull();
    expect(logRow.admin_email).toBeNull();
    expect(JSON.parse(logRow.metadata_json as string)).toEqual({
      ticket: 'CASE-789',
      admin_actor_type: 'machine',
      admin_actor_id: 'amp_mcp_admin',
      admin_auth_method: 'machine_access_token',
      admin_machine_principal_id: 'amp_mcp_admin',
      admin_machine_principal_type: 'mcp_server',
      admin_machine_credential_id: 'amk_mcp_admin',
      admin_machine_client_id: 'mcp-admin-server',
      admin_machine_client_auth_method: 'private_key_jwt',
      admin_machine_credential_strength: 'asymmetric_key',
      admin_machine_sender_constrained: false,
    });
  });
});
