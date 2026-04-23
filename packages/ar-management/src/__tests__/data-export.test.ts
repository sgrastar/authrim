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
  mockCoreAdapter,
  mockPiiAdapter,
  mockConfigManager,
} = vi.hoisted(() => {
  const coreAdapter = {
    query: vi.fn(),
    execute: vi.fn(),
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
  };
});

// Mock hono/cookie
vi.mock('hono/cookie', () => ({
  getCookie: vi.fn(),
}));

import {
  dataExportRequestHandler,
  dataExportStatusHandler,
  dataExportDownloadHandler,
} from '../data-export';
import { getCookie } from 'hono/cookie';

/**
 * Helper to create mock context
 */
function createMockContext(options: {
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  params?: Record<string, string>;
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

describe('Data Export API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('export-uuid-12345');
    // Reset adapter mocks
    mockCoreAdapter.query.mockReset();
    mockCoreAdapter.execute.mockReset();
    mockPiiAdapter.query.mockReset();
    // Reset config mocks
    mockConfigManager.getConsentDataExportEnabled.mockResolvedValue(true);
    mockConfigManager.getConsentDataExportSyncThresholdKB.mockResolvedValue(1024);
    // Reset auth mocks
    mockIntrospectTokenFromContext.mockReset();
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
  });

  describe('dataExportRequestHandler', () => {
    beforeEach(() => {
      mockIntrospectTokenFromContext.mockResolvedValue({
        valid: true,
        claims: { sub: 'user-123' },
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
        claims: { sub: 'user-123' },
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
        claims: { sub: 'user-123' },
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

    it('should load profile data from users_core/users_pii by id and tenant_id', async () => {
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
              locale: 'ja',
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
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        profile: {
          id: string;
          email: string;
          emailVerified: boolean;
          phoneNumberVerified: boolean;
          name?: string;
          locale?: string;
        };
      };
      expect(body.profile).toMatchObject({
        id: 'user-123',
        email: 'export@example.com',
        emailVerified: true,
        phoneNumberVerified: false,
        name: 'Export User',
        locale: 'ja',
      });
    });
  });
});
