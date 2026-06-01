/**
 * Data Export API Tests (GDPR Article 20)
 *
 * Tests for data portability endpoints.
 * Covers authentication, feature flags, status checking, and download flows.
 *
 * Note: Synchronous export flow tests are simplified due to complex internal
 * data collection that requires many database queries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

// Hoist mock functions
const {
  mockIntrospectTokenFromContext,
  mockGetSessionStoreBySessionId,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockCreatePIIContextFromHono,
  mockCreateOAuthConfigManager,
  mockResolveAuthCorePersistenceAdapterFromEnv,
  mockEnsureDatabaseAdapter,
  mockListObjectCatalogObjects,
  mockCoreAdapter,
  mockPiiAdapter,
  mockConfigManager,
} = vi.hoisted(() => {
  const coreAdapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(async (fn) =>
      fn({
        query: coreAdapter.query,
        queryOne: coreAdapter.queryOne,
        execute: coreAdapter.execute,
      })
    ),
  };
  const piiAdapter = {
    query: vi.fn(),
    execute: vi.fn(),
  };
  const configMgr = {
    getConsentDataExportEnabled: vi.fn().mockResolvedValue(true),
    getConsentDataExportSyncThresholdKB: vi.fn().mockResolvedValue(1024), // 1MB
  };
  return {
    mockIntrospectTokenFromContext: vi.fn(),
    mockGetSessionStoreBySessionId: vi.fn(),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({
      coreAdapter,
    }),
    mockCreatePIIContextFromHono: vi.fn().mockReturnValue({
      defaultPiiAdapter: piiAdapter,
    }),
    mockCreateOAuthConfigManager: vi.fn().mockReturnValue(configMgr),
    mockResolveAuthCorePersistenceAdapterFromEnv: vi.fn().mockResolvedValue(coreAdapter),
    mockEnsureDatabaseAdapter: vi.fn().mockReturnValue(piiAdapter),
    mockListObjectCatalogObjects: vi.fn(),
    mockCoreAdapter: coreAdapter,
    mockPiiAdapter: piiAdapter,
    mockConfigManager: configMgr,
  };
});

// Mock the shared module
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    introspectTokenFromContext: mockIntrospectTokenFromContext,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    createPIIContextFromHono: mockCreatePIIContextFromHono,
    createOAuthConfigManager: mockCreateOAuthConfigManager,
    resolveAuthCorePersistenceAdapterFromEnv: mockResolveAuthCorePersistenceAdapterFromEnv,
    ensureDatabaseAdapter: mockEnsureDatabaseAdapter,
    createObjectCatalogEntry: actual.createObjectCatalogEntry,
    getObjectCatalogObjectRecord: actual.getObjectCatalogObjectRecord,
    listObjectCatalogObjects: mockListObjectCatalogObjects,
    loadCatalogObjectArtifact: actual.loadCatalogObjectArtifact,
    encryptObjectArtifact: actual.encryptObjectArtifact,
    decryptObjectArtifact: actual.decryptObjectArtifact,
    generatePublicArtifactId: actual.generatePublicArtifactId,
  };
});

vi.mock('@authrim/ar-lib-core/services/object-artifact-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@authrim/ar-lib-core/services/object-artifact-store')>();
  return {
    ...actual,
    loadCatalogObjectArtifact: actual.loadCatalogObjectArtifact,
    loadCatalogObjectRepresentation: actual.loadCatalogObjectRepresentation,
  };
});

// Mock hono/cookie
vi.mock('hono/cookie', () => ({
  getCookie: vi.fn(),
}));

import {
  dataExportArtifactChunkHandler,
  dataExportArtifactDownloadHandler,
  dataExportArtifactManifestHandler,
  dataExportRequestHandler,
  dataExportStatusHandler,
  dataExportDownloadHandler,
  processPendingDataExportRequests,
} from '../data-export';
import { getCookie } from 'hono/cookie';

const OBJECT_ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/**
 * Helper to create mock context
 */
function createMockContext(options: {
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  env?: Partial<Env>;
}) {
  const mockEnv: Partial<Env> = {
    ISSUER_URL: 'https://op.example.com',
    ...options.env,
  };
  const contextStore = new Map<string, unknown>();

  // Setup getCookie mock
  vi.mocked(getCookie).mockImplementation((_c, name) => {
    return options.cookies?.[name] ?? undefined;
  });

  const c = {
    req: {
      header: (name: string) => options.headers?.[name],
      method: options.method || 'GET',
      param: (name: string) => options.params?.[name],
      query: (name: string) => options.query?.[name],
      json: vi.fn().mockResolvedValue(options.body || {}),
    },
    env: mockEnv as Env,
    json: vi.fn((body, status = 200) => {
      return new Response(JSON.stringify(body), { status });
    }),
    header: vi.fn(),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  } as any;

  return c;
}

function createMockR2ObjectStore(
  initial: Record<string, { body: Uint8Array; contentType?: string }> = {}
) {
  const store = new Map<string, { body: Uint8Array; contentType?: string }>(
    Object.entries(initial)
  );

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
          body: new Blob([object.body]).stream(),
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

describe('Data Export API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('export-uuid-12345');
    // Reset adapter mocks
    mockCoreAdapter.query.mockReset();
    mockCoreAdapter.queryOne.mockReset();
    mockCoreAdapter.execute.mockReset();
    mockCoreAdapter.transaction.mockImplementation(async (fn) =>
      fn({
        query: mockCoreAdapter.query,
        queryOne: mockCoreAdapter.queryOne,
        execute: mockCoreAdapter.execute,
      })
    );
    mockPiiAdapter.query.mockReset();
    // Reset config mocks
    mockConfigManager.getConsentDataExportEnabled.mockResolvedValue(true);
    mockConfigManager.getConsentDataExportSyncThresholdKB.mockResolvedValue(1024);
    // Reset auth mocks
    mockIntrospectTokenFromContext.mockReset();
    mockResolveAuthCorePersistenceAdapterFromEnv.mockResolvedValue(mockCoreAdapter);
    mockEnsureDatabaseAdapter.mockReturnValue(mockPiiAdapter);
    mockListObjectCatalogObjects.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should reject request without authentication', async () => {
      const c = createMockContext({
        method: 'POST',
      });

      const response = await dataExportRequestHandler(c);
      expect(response.status).toBe(401);

      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('unauthorized');
    });

    it('should reject request with invalid token', async () => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: false,
        claims: null,
      });

      const c = createMockContext({
        method: 'POST',
        headers: { Authorization: 'Bearer invalid-token' },
      });

      const response = await dataExportRequestHandler(c);
      expect(response.status).toBe(401);
    });

    it('should reject bearer tokens without data export scope', async () => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid profile' },
      });

      const c = createMockContext({
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      const response = await dataExportRequestHandler(c);
      expect(response.status).toBe(401);
    });
  });

  describe('dataExportRequestHandler', () => {
    beforeEach(() => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid profile data_export' },
      });
    });

    it('should return 403 when feature is disabled', async () => {
      mockConfigManager.getConsentDataExportEnabled.mockResolvedValue(false);

      const c = createMockContext({
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      const response = await dataExportRequestHandler(c);
      expect(response.status).toBe(403);

      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('feature_disabled');
    });

    it('should create async export request for large data', async () => {
      // Set low threshold to trigger async flow
      mockConfigManager.getConsentDataExportSyncThresholdKB.mockResolvedValue(0); // 0KB threshold = always async
      // Return data for all section estimates
      mockCoreAdapter.query.mockResolvedValue([{ count: 1000 }]);
      mockCoreAdapter.execute.mockResolvedValue(undefined);

      const c = createMockContext({
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      const response = await dataExportRequestHandler(c);
      expect(response.status).toBe(202);

      const body = (await response.json()) as {
        status: string;
        requestId: string;
        message: string;
      };
      expect(body.status).toBe('pending');
      expect(body.requestId).toBe('export-uuid-12345');
      expect(body.message).toContain('GET /api/user/data-export/:id');

      // Verify insert was called
      expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO data_export_requests'),
        expect.arrayContaining(['export-uuid-12345'])
      );
    });
  });

  describe('dataExportStatusHandler', () => {
    beforeEach(() => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid profile data_export' },
      });
    });

    it('should return export status', async () => {
      mockCoreAdapter.query.mockResolvedValue([
        {
          id: 'export-123',
          status: 'completed',
          format: 'json',
          include_sections: JSON.stringify(['profile', 'consents']),
          requested_at: 1700000000000,
          started_at: 1700000001000,
          completed_at: 1700000002000,
          expires_at: 1700086400000,
          file_size: 12345,
          error_message: null,
          object_catalog_id: 'catalog-123',
          public_artifact_id: 'oa_public123',
        },
      ]);

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
        params: { id: 'export-123' },
      });

      const response = await dataExportStatusHandler(c);
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.id).toBe('export-123');
      expect(body.status).toBe('completed');
      expect(body.format).toBe('json');
      expect(body.includeSections).toEqual(['profile', 'consents']);
      expect(body.completedAt).toBe(1700000002000);
      expect(body.fileSize).toBe(12345);
      expect(body.publicArtifactId).toBe('oa_public123');
      expect(body.availableFormats).toEqual(['json']);
    });

    it('should return 404 for non-existent request', async () => {
      mockCoreAdapter.query.mockResolvedValue([]);

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
        params: { id: 'nonexistent' },
      });

      const response = await dataExportStatusHandler(c);
      expect(response.status).toBe(404);

      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('not_found');
    });

    it('should return 400 if request ID is missing', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
        params: {},
      });

      const response = await dataExportStatusHandler(c);
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });
  });

  describe('dataExportDownloadHandler', () => {
    beforeEach(() => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid profile data_export' },
      });
    });

    it('should return 404 for non-existent request', async () => {
      mockCoreAdapter.query.mockResolvedValue([]);

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
        params: { id: 'nonexistent' },
      });

      const response = await dataExportDownloadHandler(c);
      expect(response.status).toBe(404);
    });

    it('should reject download if not completed', async () => {
      mockCoreAdapter.query.mockResolvedValue([
        {
          status: 'pending',
          format: 'json',
          include_sections: '[]',
          expires_at: null,
          file_path: null,
        },
      ]);

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
        params: { id: 'export-123' },
      });

      const response = await dataExportDownloadHandler(c);
      expect(response.status).toBe(409); // Conflict - not ready yet

      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('not_ready');
    });

    it('should reject expired download', async () => {
      const expiredTime = Date.now() - 86400000; // 1 day ago
      mockCoreAdapter.query.mockResolvedValue([
        {
          status: 'completed',
          format: 'json',
          include_sections: '[]',
          expires_at: expiredTime,
          file_path: null,
        },
      ]);

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
        params: { id: 'export-123' },
      });

      const response = await dataExportDownloadHandler(c);
      expect(response.status).toBe(410);

      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('expired');
    });

    it('should return a decrypted materialized export object from EXPORT_ARTIFACTS when present', async () => {
      const exportBody = JSON.stringify({ profile: { id: 'user-123' } });
      const { encryptObjectArtifact } = await import('@authrim/ar-lib-core');
      const envelope = await encryptObjectArtifact(exportBody, {
        rootKeyHex: OBJECT_ROOT_KEY,
        plane: 'EXPORT_ARTIFACTS',
        keyVersion: 1,
        contentType: 'application/json',
        context: {
          tenantId: 'default',
          objectKey: 'exports/default/data-export/export-123/artifact.json',
          objectClass: 'user_export',
        },
      });
      const { bucket } = createMockR2ObjectStore({
        'exports/default/data-export/export-123/artifact.json': {
          body: new TextEncoder().encode(JSON.stringify(envelope)),
          contentType: 'application/vnd.authrim.object-envelope+json',
        },
      });
      mockCoreAdapter.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM data_export_requests der')) {
          return [
            {
              status: 'completed',
              format: 'json',
              include_sections: '[]',
              expires_at: Date.now() + 60_000,
              file_path: 'exports/default/data-export/export-123/artifact.json',
              object_catalog_id: 'catalog-123',
              public_artifact_id: 'oa_public123',
            },
          ];
        }

        if (sql.includes('FROM object_catalog oc')) {
          return [
            {
              catalog_id: 'catalog-123',
              public_artifact_id: 'oa_public123',
              tenant_id: 'default',
              object_class: 'user_export',
              catalog_created_at: Date.now(),
              catalog_updated_at: Date.now(),
              catalog_deleted_at: null,
              physical_id: 'physical-1',
              representation: 'canonical_json',
              object_kind: 'single',
              object_index: 0,
              bucket_binding: 'EXPORT_ARTIFACTS',
              object_key: 'exports/default/data-export/export-123/artifact.json',
              key_version: 1,
              checksum_sha256: null,
              total_bytes: 256,
              physical_created_at: Date.now(),
              physical_deleted_at: null,
            },
          ];
        }

        return [];
      });
      mockCoreAdapter.queryOne.mockResolvedValue({
        catalog_id: 'catalog-123',
        public_artifact_id: 'oa_public123',
        tenant_id: 'default',
        object_class: 'user_export',
        catalog_created_at: Date.now(),
        catalog_updated_at: Date.now(),
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: 'exports/default/data-export/export-123/artifact.json',
        key_version: 1,
        checksum_sha256: null,
        total_bytes: 256,
        physical_created_at: Date.now(),
        physical_deleted_at: null,
      });

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
        params: { id: 'export-123' },
        env: { EXPORT_ARTIFACTS: bucket, OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY },
      });

      const response = await dataExportDownloadHandler(c);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.headers.get('Content-Disposition')).toContain('.json');
      expect(await response.text()).toBe(exportBody);
      expect(mockPiiAdapter.query).not.toHaveBeenCalled();
    });

    it('should return manifest view for a materialized export', async () => {
      mockCoreAdapter.query.mockResolvedValue([
        {
          id: 'export-123',
          status: 'completed',
          format: 'json',
          include_sections: '[]',
          expires_at: Date.now() + 60_000,
          file_path: 'exports/default/data-export/export-123/artifact.json',
          object_catalog_id: 'catalog-123',
          public_artifact_id: 'oa_public123',
        },
      ]);
      mockListObjectCatalogObjects.mockResolvedValue({
        logical: {
          id: 'catalog-123',
          publicArtifactId: 'oa_public123',
          tenantId: 'default',
          objectClass: 'user_export',
          createdAt: 1700000002000,
          updatedAt: 1700000002000,
          deletedAt: null,
        },
        physical: [
          {
            id: 'physical-1',
            catalogId: 'catalog-123',
            representation: 'canonical_json',
            objectKind: 'single',
            bucketBinding: 'EXPORT_ARTIFACTS',
            objectKey: 'exports/default/data-export/export-123/artifact.json',
            chunkIndex: 0,
            keyVersion: 1,
            checksumSha256: 'abc123',
            totalBytes: 512,
            createdAt: 1700000002000,
            deletedAt: null,
          },
        ],
      });

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
        params: { id: 'export-123' },
        query: { view: 'manifest' },
      });

      const response = await dataExportDownloadHandler(c);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.artifactId).toBe('oa_public123');
      expect(body.requestId).toBe('export-123');
      expect(body.availableFormats).toEqual(['json']);
    });

    it('should require authentication', async () => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: false,
        claims: null,
      });

      const c = createMockContext({
        headers: { Authorization: 'Bearer invalid' },
        params: { id: 'export-123' },
      });

      const response = await dataExportDownloadHandler(c);
      expect(response.status).toBe(401);
    });

    it('returns not_materialized when a completed export has no object-backed artifact', async () => {
      mockCoreAdapter.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM data_export_requests')) {
          expect(params).toEqual(['export-123', 'user-123', 'default']);
          return [
            {
              status: 'completed',
              format: 'json',
              include_sections: JSON.stringify(['profile']),
              expires_at: Date.now() + 60_000,
              file_path: null,
              object_catalog_id: null,
            },
          ];
        }

        return [];
      });

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
        params: { id: 'export-123' },
      });

      const response = await dataExportDownloadHandler(c);
      expect(response.status).toBe(409);

      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('not_materialized');
      expect(mockPiiAdapter.query).not.toHaveBeenCalled();
    });
  });

  describe('artifact-based data export handlers', () => {
    beforeEach(() => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123', scope: 'openid profile data_export' },
      });
    });

    it('returns manifest by public artifact id', async () => {
      mockCoreAdapter.query.mockResolvedValue([
        {
          id: 'export-123',
          status: 'completed',
          format: 'json',
          include_sections: '[]',
          expires_at: Date.now() + 60_000,
          file_path: 'exports/default/data-export/export-123/artifact.json',
          object_catalog_id: 'catalog-123',
          public_artifact_id: 'oa_public123',
        },
      ]);
      mockListObjectCatalogObjects.mockResolvedValue({
        logical: {
          id: 'catalog-123',
          publicArtifactId: 'oa_public123',
          tenantId: 'default',
          objectClass: 'user_export',
          createdAt: 1700000002000,
          updatedAt: 1700000002000,
          deletedAt: null,
        },
        physical: [
          {
            id: 'physical-1',
            catalogId: 'catalog-123',
            representation: 'canonical_json',
            objectKind: 'single',
            bucketBinding: 'EXPORT_ARTIFACTS',
            objectKey: 'exports/default/data-export/export-123/artifact.json',
            chunkIndex: 0,
            keyVersion: 1,
            checksumSha256: 'abc123',
            totalBytes: 512,
            createdAt: 1700000002000,
            deletedAt: null,
          },
        ],
      });

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
        params: { artifactId: 'oa_public123' },
      });

      const response = await dataExportArtifactManifestHandler(c);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.artifactId).toBe('oa_public123');
    });

    it('downloads a materialized artifact by public artifact id', async () => {
      const exportBody = JSON.stringify({ profile: { id: 'user-123' } });
      const { encryptObjectArtifact } = await import('@authrim/ar-lib-core');
      const envelope = await encryptObjectArtifact(exportBody, {
        rootKeyHex: OBJECT_ROOT_KEY,
        plane: 'EXPORT_ARTIFACTS',
        keyVersion: 1,
        contentType: 'application/json',
        context: {
          tenantId: 'default',
          objectKey: 'exports/default/data-export/export-123/artifact.json',
          objectClass: 'user_export',
        },
      });
      const { bucket } = createMockR2ObjectStore({
        'exports/default/data-export/export-123/artifact.json': {
          body: new TextEncoder().encode(JSON.stringify(envelope)),
          contentType: 'application/vnd.authrim.object-envelope+json',
        },
      });
      mockCoreAdapter.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM data_export_requests der')) {
          return [
            {
              id: 'export-123',
              status: 'completed',
              format: 'json',
              include_sections: '[]',
              expires_at: Date.now() + 60_000,
              file_path: 'exports/default/data-export/export-123/artifact.json',
              object_catalog_id: 'catalog-123',
              public_artifact_id: 'oa_public123',
            },
          ];
        }

        if (sql.includes('FROM object_catalog oc')) {
          return [
            {
              catalog_id: 'catalog-123',
              public_artifact_id: 'oa_public123',
              tenant_id: 'default',
              object_class: 'user_export',
              catalog_created_at: Date.now(),
              catalog_updated_at: Date.now(),
              catalog_deleted_at: null,
              physical_id: 'physical-1',
              representation: 'canonical_json',
              object_kind: 'single',
              object_index: 0,
              bucket_binding: 'EXPORT_ARTIFACTS',
              object_key: 'exports/default/data-export/export-123/artifact.json',
              key_version: 1,
              checksum_sha256: null,
              total_bytes: 256,
              physical_created_at: Date.now(),
              physical_deleted_at: null,
            },
          ];
        }

        return [];
      });
      mockCoreAdapter.queryOne.mockResolvedValue({
        catalog_id: 'catalog-123',
        public_artifact_id: 'oa_public123',
        tenant_id: 'default',
        object_class: 'user_export',
        catalog_created_at: Date.now(),
        catalog_updated_at: Date.now(),
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: 'exports/default/data-export/export-123/artifact.json',
        key_version: 1,
        checksum_sha256: null,
        total_bytes: 256,
        physical_created_at: Date.now(),
        physical_deleted_at: null,
      });

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
        params: { artifactId: 'oa_public123' },
        env: { EXPORT_ARTIFACTS: bucket, OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY },
      });

      const response = await dataExportArtifactDownloadHandler(c);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(exportBody);
    });

    it('downloads chunk zero for a single-object artifact', async () => {
      const exportBody = JSON.stringify({ profile: { id: 'user-123' } });
      const { encryptObjectArtifact } = await import('@authrim/ar-lib-core');
      const envelope = await encryptObjectArtifact(exportBody, {
        rootKeyHex: OBJECT_ROOT_KEY,
        plane: 'EXPORT_ARTIFACTS',
        keyVersion: 1,
        contentType: 'application/json',
        context: {
          tenantId: 'default',
          objectKey: 'exports/default/data-export/export-123/artifact.json',
          objectClass: 'user_export',
        },
      });
      const { bucket } = createMockR2ObjectStore({
        'exports/default/data-export/export-123/artifact.json': {
          body: new TextEncoder().encode(JSON.stringify(envelope)),
          contentType: 'application/vnd.authrim.object-envelope+json',
        },
      });
      mockCoreAdapter.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM data_export_requests der')) {
          return [
            {
              id: 'export-123',
              status: 'completed',
              format: 'json',
              include_sections: '[]',
              expires_at: Date.now() + 60_000,
              file_path: 'exports/default/data-export/export-123/artifact.json',
              object_catalog_id: 'catalog-123',
              public_artifact_id: 'oa_public123',
            },
          ];
        }

        if (sql.includes('FROM object_catalog oc')) {
          return [
            {
              catalog_id: 'catalog-123',
              public_artifact_id: 'oa_public123',
              tenant_id: 'default',
              object_class: 'user_export',
              catalog_created_at: Date.now(),
              catalog_updated_at: Date.now(),
              catalog_deleted_at: null,
              physical_id: 'physical-1',
              representation: 'canonical_json',
              object_kind: 'single',
              object_index: 0,
              bucket_binding: 'EXPORT_ARTIFACTS',
              object_key: 'exports/default/data-export/export-123/artifact.json',
              key_version: 1,
              checksum_sha256: null,
              total_bytes: 256,
              physical_created_at: Date.now(),
              physical_deleted_at: null,
            },
          ];
        }

        return [];
      });
      mockCoreAdapter.queryOne.mockResolvedValue({
        catalog_id: 'catalog-123',
        public_artifact_id: 'oa_public123',
        tenant_id: 'default',
        object_class: 'user_export',
        catalog_created_at: Date.now(),
        catalog_updated_at: Date.now(),
        catalog_deleted_at: null,
        physical_id: 'physical-1',
        representation: 'canonical_json',
        object_kind: 'single',
        object_index: 0,
        bucket_binding: 'EXPORT_ARTIFACTS',
        object_key: 'exports/default/data-export/export-123/artifact.json',
        key_version: 1,
        checksum_sha256: null,
        total_bytes: 256,
        physical_created_at: Date.now(),
        physical_deleted_at: null,
      });

      const c = createMockContext({
        headers: { Authorization: 'Bearer token' },
        params: { artifactId: 'oa_public123', index: '0' },
        env: { EXPORT_ARTIFACTS: bucket, OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY },
      });

      const response = await dataExportArtifactChunkHandler(c);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(exportBody);
    });
  });

  describe('processPendingDataExportRequests', () => {
    it('materializes pending export requests into encrypted EXPORT_ARTIFACTS objects', async () => {
      const { bucket, store } = createMockR2ObjectStore();
      mockCoreAdapter.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (
          sql.includes('FROM data_export_requests') &&
          sql.includes("status IN ('pending', 'processing')")
        ) {
          return [
            {
              id: 'export-123',
              tenant_id: 'default',
              user_id: 'user-123',
              status: 'pending',
              format: 'json',
              include_sections: JSON.stringify(['profile']),
              requested_at: 1700000000000,
            },
          ];
        }

        if (sql.includes('FROM users_core WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['user-123', 'default']);
          return [
            {
              id: 'user-123',
              email_domain_hash: null,
              created_at: 1700000000000,
              updated_at: 1700000001000,
              email_verified: 1,
              phone_number_verified: 0,
            },
          ];
        }

        return [];
      });

      mockPiiAdapter.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT * FROM users_pii WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['user-123', 'default']);
          return [
            {
              id: 'user-123',
              tenant_id: 'default',
              email: 'export@example.com',
              name: 'Export User',
            },
          ];
        }
        return [];
      });

      mockCoreAdapter.execute.mockResolvedValue({ rowsAffected: 1, success: true });

      const logger = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await processPendingDataExportRequests(
        {
          DB_PII: {} as D1Database,
          EXPORT_ARTIFACTS: bucket,
          OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
          OBJECT_ENCRYPTION_KEY_VERSION: '2',
        } as unknown as Env,
        logger
      );

      expect(store.has('exports/default/data-export/export-123/artifact.json')).toBe(true);
      expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
        "UPDATE data_export_requests SET status = 'processing', started_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
        [expect.any(Number), 'export-123', 'default']
      );
      expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO object_catalog'),
        expect.arrayContaining(['default', 'user_export'])
      );
      expect(mockCoreAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE data_export_requests'),
        expect.arrayContaining(['exports/default/data-export/export-123/artifact.json'])
      );
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});
