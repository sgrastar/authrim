/**
 * Webhook Admin API Tests
 *
 * Comprehensive tests for webhook management endpoints:
 * - POST /api/admin/webhooks - Create webhook
 * - GET /api/admin/webhooks - List webhooks
 * - GET /api/admin/webhooks/:id - Get webhook
 * - PUT /api/admin/webhooks/:id - Update webhook
 * - DELETE /api/admin/webhooks/:id - Delete webhook
 * - POST /api/admin/webhooks/:id/test - Test webhook
 * - GET /api/admin/webhooks/:id/deliveries - List deliveries
 * - POST /api/admin/webhooks/:id/replay - Replay delivery
 *
 * Security tests:
 * - HMAC-SHA256 signature generation
 * - Secret encryption (AES-256-GCM)
 * - SSRF prevention
 * - ReDoS prevention
 * - Tenant isolation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

// Use vi.hoisted to define mocks that will be used in vi.mock factory
const {
  mockCreateAuditLogFromContext,
  mockCreateAuthContextFromHono,
  mockValidateEventPattern,
  mockEncryptValue,
  mockDecryptValue,
  mockGetTenantIdFromContext,
  mockGetLogger,
  mockWebhookRegistry,
  mockD1AdapterQuery,
  mockD1AdapterQueryOne,
  mockD1AdapterExecute,
  mockGrantRepo,
} = vi.hoisted(() => ({
  mockCreateAuditLogFromContext: vi.fn(),
  mockCreateAuthContextFromHono: vi.fn(),
  mockValidateEventPattern: vi.fn(),
  mockEncryptValue: vi.fn(),
  mockDecryptValue: vi.fn(),
  mockGetTenantIdFromContext: vi.fn().mockReturnValue('test-tenant'),
  mockGetLogger: vi.fn().mockReturnValue({
    module: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  mockWebhookRegistry: {
    register: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  mockD1AdapterQuery: vi.fn(),
  mockD1AdapterQueryOne: vi.fn(),
  mockD1AdapterExecute: vi.fn(),
  mockGrantRepo: {
    getElevationGrantByPublicId: vi.fn(),
    listActiveElevationGrants: vi.fn(),
  },
}));

// Helper to reset all mocks to their default implementation
// Note: vitest 4.x requires separate calls for mockReset() and mockReturnValue()
function resetMocks() {
  mockCreateAuditLogFromContext.mockReset();
  mockCreateAuditLogFromContext.mockResolvedValue(undefined);

  mockCreateAuthContextFromHono.mockReset();
  mockCreateAuthContextFromHono.mockReturnValue({
    coreAdapter: {
      query: mockD1AdapterQuery,
      queryOne: mockD1AdapterQueryOne,
      execute: mockD1AdapterExecute,
    },
  });

  mockValidateEventPattern.mockReset();

  mockEncryptValue.mockReset();
  mockEncryptValue.mockResolvedValue({ encrypted: 'encrypted-value', iv: 'iv' });

  mockDecryptValue.mockReset();

  mockGetTenantIdFromContext.mockReset();
  mockGetTenantIdFromContext.mockReturnValue('test-tenant');

  mockGetLogger.mockReset();
  mockGetLogger.mockReturnValue({
    module: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  });

  mockWebhookRegistry.register.mockReset();
  mockWebhookRegistry.get.mockReset();
  mockWebhookRegistry.list.mockReset();
  mockWebhookRegistry.update.mockReset();
  mockWebhookRegistry.remove.mockReset();

  mockD1AdapterQuery.mockReset();
  mockD1AdapterQueryOne.mockReset();
  mockD1AdapterExecute.mockReset();
  mockGrantRepo.getElevationGrantByPublicId.mockReset();
  mockGrantRepo.listActiveElevationGrants.mockReset();
  mockGrantRepo.listActiveElevationGrants.mockResolvedValue([]);
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLogFromContext: mockCreateAuditLogFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    validateEventPattern: mockValidateEventPattern,
    encryptValue: mockEncryptValue,
    decryptValue: mockDecryptValue,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    getLogger: mockGetLogger,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({
      query: mockD1AdapterQuery,
      queryOne: mockD1AdapterQueryOne,
      execute: mockD1AdapterExecute,
    })),
    D1Adapter: vi.fn().mockImplementation(function () {
      return {
        query: mockD1AdapterQuery,
        queryOne: mockD1AdapterQueryOne,
        execute: mockD1AdapterExecute,
      };
    }),
    createWebhookRegistry: vi.fn().mockImplementation(function () {
      return mockWebhookRegistry;
    }),
    ElevationGrantRepository: vi.fn(function MockElevationGrantRepository() {
      return mockGrantRepo;
    }),
    loadCatalogObjectJson: actual.loadCatalogObjectJson,
  };
});

import {
  createWebhook,
  listWebhooks,
  getWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  listWebhookDeliveries,
  getWebhookDelivery,
  replayWebhookDelivery,
} from '../routes/settings/webhooks';
import { encryptObjectArtifact } from '@authrim/ar-lib-core/services/object-artifact-crypto';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockKV(options: {
  getValues?: Record<string, string | null>;
  putCallback?: (key: string, value: string) => void;
}): KVNamespace {
  const storage = new Map<string, string>(
    Object.entries(options.getValues ?? {}).filter(([, v]) => v !== null) as [string, string][]
  );

  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      return storage.get(key) ?? null;
    }),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
      options.putCallback?.(key, value);
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [] }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function createMockDB(): D1Database {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    }),
    dump: vi.fn(),
    batch: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

function createMockBucket(initial: Record<string, string> = {}): R2Bucket {
  const storage = new Map<string, string>(Object.entries(initial));
  return {
    put: vi.fn(async (key: string, value: ArrayBuffer | ArrayBufferView | string) => {
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof Uint8Array
            ? value
            : value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const text = typeof value === 'string' ? value : new TextDecoder().decode(bytes);
      storage.set(key, text);
    }),
    get: vi.fn(async (key: string) => {
      const value = storage.get(key);
      if (!value) {
        return null;
      }
      return {
        text: async () => value,
        writeHttpMetadata: vi.fn(),
      };
    }),
    delete: vi.fn(),
    list: vi.fn(),
    head: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

function createMockContext(options: {
  method?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  kv?: KVNamespace;
  db?: D1Database;
  tenantId?: string;
  piiEncryptionKey?: string;
  environment?: string;
  sensitiveDetails?: R2Bucket;
  objectEncryptionRootKey?: string;
  objectEncryptionKeyVersion?: string;
  adminPermissions?: string[];
}) {
  const mockKV = options.kv ?? createMockKV({});
  const mockDB = options.db ?? createMockDB();

  if (options.tenantId) {
    mockGetTenantIdFromContext.mockReturnValue(options.tenantId);
  }

  const queryStore = new Map<string, string>(Object.entries(options.query ?? {}));

  const c = {
    req: {
      method: options.method || 'GET',
      param: vi.fn().mockImplementation((name: string) => options.params?.[name]),
      query: vi.fn().mockImplementation((name?: string) => {
        if (name) return queryStore.get(name);
        return Object.fromEntries(queryStore);
      }),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
      header: vi.fn().mockReturnValue(null),
      path: '/api/admin/webhooks',
    },
    env: {
      SETTINGS: mockKV,
      DB: mockDB,
      ISSUER_URL: 'https://op.example.com',
      PII_ENCRYPTION_KEY: options.piiEncryptionKey ?? 'test-encryption-key-32-chars-xx',
      ENVIRONMENT: options.environment ?? 'development',
      SENSITIVE_DETAILS: options.sensitiveDetails,
      OBJECT_ENCRYPTION_ROOT_KEY: options.objectEncryptionRootKey,
      OBJECT_ENCRYPTION_KEY_VERSION: options.objectEncryptionKeyVersion,
    } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'tenantId') return options.tenantId ?? 'test-tenant';
      if (key === 'adminAuth') {
        return {
          userId: 'admin-1',
          authMethod: 'password',
          permissions: options.adminPermissions ?? ['*'],
        };
      }
      return undefined;
    }),
    set: vi.fn(),
    _mockKV: mockKV,
    _mockDB: mockDB,
  } as any;

  return c;
}

async function getResponseData(response: Response | void): Promise<{ body: any; status: number }> {
  if (!response) {
    return { body: null, status: 200 };
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { body, status: response.status };
}

function createWebhookEntry(
  overrides: Partial<{
    id: string;
    tenantId: string;
    clientId: string | null;
    scope: 'tenant' | 'client';
    name: string;
    url: string;
    events: string[];
    secretEncrypted: string | null;
    headers: Record<string, string> | null;
    retryPolicy: object;
    timeoutMs: number;
    active: boolean;
    createdAt: string;
    updatedAt: string;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
  }> = {}
) {
  return {
    id: overrides.id ?? 'webhook-1',
    tenantId: overrides.tenantId ?? 'test-tenant',
    clientId: overrides.clientId ?? null,
    scope: overrides.scope ?? 'tenant',
    name: overrides.name ?? 'Test Webhook',
    url: overrides.url ?? 'https://example.com/webhook',
    events: overrides.events ?? ['user.created', 'user.updated'],
    secretEncrypted: overrides.secretEncrypted ?? null,
    headers: overrides.headers ?? null,
    retryPolicy: overrides.retryPolicy ?? {
      maxRetries: 3,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
      maxDelayMs: 60000,
    },
    timeoutMs: overrides.timeoutMs ?? 30000,
    active: overrides.active ?? true,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    lastSuccessAt: overrides.lastSuccessAt ?? null,
    lastFailureAt: overrides.lastFailureAt ?? null,
  };
}

// =============================================================================
// Create Webhook Tests
// =============================================================================

describe('Webhook Admin API - Create Webhook', () => {
  beforeEach(() => {
    resetMocks();
    mockValidateEventPattern.mockReturnValue({ valid: true });
    mockEncryptValue.mockResolvedValue({ encrypted: 'encrypted-secret' });
  });

  describe('POST /api/admin/webhooks', () => {
    it('should create a webhook with valid input', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          name: 'My Webhook',
          url: 'https://example.com/webhook',
          events: ['user.created'],
        },
      });

      mockWebhookRegistry.register.mockResolvedValue('webhook-123');
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));

      await createWebhook(c);

      expect(c.json).toHaveBeenCalled();
      const [response, status] = c.json.mock.calls[0];
      expect(status).toBe(201);
      expect(response.success).toBe(true);
      expect(response.webhook).toBeDefined();
    });

    it('should reject invalid JSON body', async () => {
      const c = createMockContext({ method: 'POST' });
      c.req.json.mockRejectedValue(new Error('Invalid JSON'));

      await createWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_request' }),
        400
      );
    });

    it('should require name field', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          url: 'https://example.com/webhook',
          events: ['user.created'],
        },
      });

      await createWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('name'),
        }),
        400
      );
    });

    it('should require url field', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          name: 'My Webhook',
          events: ['user.created'],
        },
      });

      await createWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('url'),
        }),
        400
      );
    });

    it('should require events array', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          name: 'My Webhook',
          url: 'https://example.com/webhook',
        },
      });

      await createWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('events'),
        }),
        400
      );
    });

    it('should require non-empty events array', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          name: 'My Webhook',
          url: 'https://example.com/webhook',
          events: [],
        },
      });

      await createWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('events'),
        }),
        400
      );
    });

    it('should validate event patterns', async () => {
      mockValidateEventPattern.mockReturnValue({ valid: false, error: 'Invalid pattern' });

      const c = createMockContext({
        method: 'POST',
        body: {
          name: 'My Webhook',
          url: 'https://example.com/webhook',
          events: ['invalid..pattern'],
        },
      });

      await createWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('Invalid event pattern'),
        }),
        400
      );
    });

    it('should validate timeoutMs range (min 1000ms)', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          name: 'My Webhook',
          url: 'https://example.com/webhook',
          events: ['user.created'],
          timeoutMs: 500, // Below minimum
        },
      });

      await createWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('timeoutMs'),
        }),
        400
      );
    });

    it('should validate timeoutMs range (max 60000ms)', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          name: 'My Webhook',
          url: 'https://example.com/webhook',
          events: ['user.created'],
          timeoutMs: 120000, // Above maximum
        },
      });

      await createWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('timeoutMs'),
        }),
        400
      );
    });

    it('should validate retryPolicy.maxRetries range (0-10)', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          name: 'My Webhook',
          url: 'https://example.com/webhook',
          events: ['user.created'],
          retryPolicy: { maxRetries: 15 }, // Above maximum
        },
      });

      await createWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('maxRetries'),
        }),
        400
      );
    });

    it('should create audit log on successful creation', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          name: 'My Webhook',
          url: 'https://example.com/webhook',
          events: ['user.created'],
        },
      });

      mockWebhookRegistry.register.mockResolvedValue('webhook-123');
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));

      await createWebhook(c);

      expect(mockCreateAuditLogFromContext).toHaveBeenCalledWith(
        c,
        'webhook.created',
        'webhook',
        'webhook-123',
        expect.any(Object)
      );
    });

    it('should create webhook with secret and encrypt it', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          name: 'My Webhook',
          url: 'https://example.com/webhook',
          events: ['user.created'],
          secret: 'my-secret-key',
        },
      });

      mockWebhookRegistry.register.mockResolvedValue('webhook-123');
      mockWebhookRegistry.get.mockResolvedValue(
        createWebhookEntry({ id: 'webhook-123', secretEncrypted: 'encrypted-secret' })
      );

      await createWebhook(c);

      const [response] = c.json.mock.calls[0];
      expect(response.success).toBe(true);
      // Secret should not be exposed in response
      expect(response.webhook.secret).toBeUndefined();
      expect(response.webhook.secretEncrypted).toBeUndefined();
      expect(response.webhook.hasSecret).toBe(true);
    });
  });
});

// =============================================================================
// List Webhooks Tests
// =============================================================================

describe('Webhook Admin API - List Webhooks', () => {
  beforeEach(() => {
    resetMocks();
  });

  describe('GET /api/admin/webhooks', () => {
    it('should return empty list when no webhooks', async () => {
      const c = createMockContext({});
      mockWebhookRegistry.list.mockResolvedValue([]);

      await listWebhooks(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          webhooks: [],
          total: 0,
        })
      );
    });

    it('should return webhooks for tenant', async () => {
      const c = createMockContext({});
      mockWebhookRegistry.list.mockResolvedValue([
        createWebhookEntry({ id: 'webhook-1' }),
        createWebhookEntry({ id: 'webhook-2' }),
      ]);

      await listWebhooks(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          webhooks: expect.arrayContaining([
            expect.objectContaining({ id: 'webhook-1' }),
            expect.objectContaining({ id: 'webhook-2' }),
          ]),
          total: 2,
        })
      );
    });

    it('should filter by scope', async () => {
      const c = createMockContext({
        query: { scope: 'client' },
      });
      mockWebhookRegistry.list.mockResolvedValue([]);

      await listWebhooks(c);

      expect(mockWebhookRegistry.list).toHaveBeenCalledWith(
        'test-tenant',
        expect.objectContaining({ scope: 'client' })
      );
    });

    it('should filter by clientId', async () => {
      const c = createMockContext({
        query: { clientId: 'client-123' },
      });
      mockWebhookRegistry.list.mockResolvedValue([]);

      await listWebhooks(c);

      expect(mockWebhookRegistry.list).toHaveBeenCalledWith(
        'test-tenant',
        expect.objectContaining({ clientId: 'client-123' })
      );
    });

    it('should filter by activeOnly', async () => {
      const c = createMockContext({
        query: { activeOnly: 'true' },
      });
      mockWebhookRegistry.list.mockResolvedValue([]);

      await listWebhooks(c);

      expect(mockWebhookRegistry.list).toHaveBeenCalledWith(
        'test-tenant',
        expect.objectContaining({ activeOnly: true })
      );
    });

    it('should not expose secretEncrypted in response', async () => {
      const c = createMockContext({});
      mockWebhookRegistry.list.mockResolvedValue([
        createWebhookEntry({ secretEncrypted: 'encrypted-secret' }),
      ]);

      await listWebhooks(c);

      const [response] = c.json.mock.calls[0];
      expect(response.webhooks[0].secretEncrypted).toBeUndefined();
      expect(response.webhooks[0].hasSecret).toBe(true);
    });
  });
});

// =============================================================================
// Get Webhook Tests
// =============================================================================

describe('Webhook Admin API - Get Webhook', () => {
  beforeEach(() => {
    resetMocks();
  });

  describe('GET /api/admin/webhooks/:id', () => {
    it('should return webhook by ID', async () => {
      const c = createMockContext({
        params: { id: 'webhook-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));

      await getWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          webhook: expect.objectContaining({ id: 'webhook-123' }),
        })
      );
    });

    it('should return 404 for non-existent webhook', async () => {
      const c = createMockContext({
        params: { id: 'non-existent' },
      });
      mockWebhookRegistry.get.mockResolvedValue(null);

      await getWebhook(c);

      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'not_found' }), 404);
    });

    it('should not expose secretEncrypted in response', async () => {
      const c = createMockContext({
        params: { id: 'webhook-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(
        createWebhookEntry({ secretEncrypted: 'encrypted-secret' })
      );

      await getWebhook(c);

      const [response] = c.json.mock.calls[0];
      expect(response.webhook.secretEncrypted).toBeUndefined();
      expect(response.webhook.hasSecret).toBe(true);
    });

    it('should enforce tenant isolation', async () => {
      const c = createMockContext({
        params: { id: 'webhook-123' },
        tenantId: 'tenant-a',
      });
      // Webhook belongs to different tenant
      mockWebhookRegistry.get.mockResolvedValue(null);

      await getWebhook(c);

      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'not_found' }), 404);
    });
  });
});

// =============================================================================
// Update Webhook Tests
// =============================================================================

describe('Webhook Admin API - Update Webhook', () => {
  beforeEach(() => {
    resetMocks();
    mockValidateEventPattern.mockReturnValue({ valid: true });
  });

  describe('PUT /api/admin/webhooks/:id', () => {
    it('should update webhook with valid input', async () => {
      const c = createMockContext({
        method: 'PUT',
        params: { id: 'webhook-123' },
        body: { name: 'Updated Webhook' },
      });
      mockWebhookRegistry.get
        .mockResolvedValueOnce(createWebhookEntry({ id: 'webhook-123' })) // Before update
        .mockResolvedValueOnce(createWebhookEntry({ id: 'webhook-123', name: 'Updated Webhook' })); // After update
      mockWebhookRegistry.update.mockResolvedValue(undefined);

      await updateWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          webhook: expect.objectContaining({ id: 'webhook-123' }),
        })
      );
    });

    it('should return 404 for non-existent webhook', async () => {
      const c = createMockContext({
        method: 'PUT',
        params: { id: 'non-existent' },
        body: { name: 'Updated' },
      });
      mockWebhookRegistry.get.mockResolvedValue(null);

      await updateWebhook(c);

      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'not_found' }), 404);
    });

    it('should reject invalid JSON body', async () => {
      const c = createMockContext({
        method: 'PUT',
        params: { id: 'webhook-123' },
      });
      c.req.json.mockRejectedValue(new Error('Invalid JSON'));

      await updateWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_request' }),
        400
      );
    });

    it('should validate event patterns when updating events', async () => {
      mockValidateEventPattern.mockReturnValue({ valid: false, error: 'Invalid pattern' });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'webhook-123' },
        body: { events: ['invalid..pattern'] },
      });

      await updateWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('Invalid event pattern'),
        }),
        400
      );
    });

    it('should create audit log on successful update', async () => {
      const c = createMockContext({
        method: 'PUT',
        params: { id: 'webhook-123' },
        body: { name: 'Updated Webhook' },
      });
      mockWebhookRegistry.get
        .mockResolvedValueOnce(createWebhookEntry({ id: 'webhook-123' }))
        .mockResolvedValueOnce(createWebhookEntry({ id: 'webhook-123', name: 'Updated Webhook' }));
      mockWebhookRegistry.update.mockResolvedValue(undefined);

      await updateWebhook(c);

      expect(mockCreateAuditLogFromContext).toHaveBeenCalledWith(
        c,
        'webhook.updated',
        'webhook',
        'webhook-123',
        expect.any(Object)
      );
    });

    it('should allow updating webhook to inactive', async () => {
      const c = createMockContext({
        method: 'PUT',
        params: { id: 'webhook-123' },
        body: { active: false },
      });
      mockWebhookRegistry.get
        .mockResolvedValueOnce(createWebhookEntry({ id: 'webhook-123', active: true }))
        .mockResolvedValueOnce(createWebhookEntry({ id: 'webhook-123', active: false }));
      mockWebhookRegistry.update.mockResolvedValue(undefined);

      await updateWebhook(c);

      expect(mockWebhookRegistry.update).toHaveBeenCalledWith(
        'test-tenant',
        'webhook-123',
        expect.objectContaining({ active: false })
      );
    });
  });
});

// =============================================================================
// Delete Webhook Tests
// =============================================================================

describe('Webhook Admin API - Delete Webhook', () => {
  beforeEach(() => {
    resetMocks();
  });

  describe('DELETE /api/admin/webhooks/:id', () => {
    it('should delete webhook', async () => {
      const c = createMockContext({
        method: 'DELETE',
        params: { id: 'webhook-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));
      mockWebhookRegistry.remove.mockResolvedValue(undefined);

      await deleteWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          deleted: 'webhook-123',
        })
      );
    });

    it('should return 404 for non-existent webhook', async () => {
      const c = createMockContext({
        method: 'DELETE',
        params: { id: 'non-existent' },
      });
      mockWebhookRegistry.get.mockResolvedValue(null);

      await deleteWebhook(c);

      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'not_found' }), 404);
    });

    it('should create audit log with warning level', async () => {
      const c = createMockContext({
        method: 'DELETE',
        params: { id: 'webhook-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));
      mockWebhookRegistry.remove.mockResolvedValue(undefined);

      await deleteWebhook(c);

      expect(mockCreateAuditLogFromContext).toHaveBeenCalledWith(
        c,
        'webhook.deleted',
        'webhook',
        'webhook-123',
        expect.any(Object),
        'warning'
      );
    });
  });
});

// =============================================================================
// Test Webhook Tests
// =============================================================================

describe('Webhook Admin API - Test Webhook', () => {
  beforeEach(() => {
    resetMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('POST /api/admin/webhooks/:id/test', () => {
    it('should return 400 if webhook ID is missing', async () => {
      const c = createMockContext({
        method: 'POST',
        params: {},
      });

      await testWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('Webhook ID'),
        }),
        400
      );
    });

    it('should return 404 for non-existent webhook', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'non-existent' },
      });
      mockWebhookRegistry.get.mockResolvedValue(null);

      await testWebhook(c);

      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'not_found' }), 404);
    });

    it('should send test webhook and return success', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));

      await testWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          webhook_id: 'webhook-123',
          status_code: 200,
        })
      );
    });

    it('should return success=false for non-2xx response', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));

      await testWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          webhook_id: 'webhook-123',
          status_code: 404,
        })
      );
    });

    it('should include X-Webhook-Event header in request', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));

      await testWebhook(c);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Webhook-Event': 'webhook.test',
          }),
        })
      );
    });

    it('should generate HMAC signature when secret is configured', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
        piiEncryptionKey: 'test-key-32-characters-long-xxx',
      });
      mockWebhookRegistry.get.mockResolvedValue(
        createWebhookEntry({ id: 'webhook-123', secretEncrypted: 'encrypted-secret' })
      );
      mockDecryptValue.mockResolvedValue({ decrypted: 'my-secret' });

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));

      await testWebhook(c);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Webhook-Signature': expect.stringMatching(/^sha256=[a-f0-9]+$/),
          }),
        })
      );
    });

    it('should handle fetch timeout', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(
        createWebhookEntry({ id: 'webhook-123', timeoutMs: 1000 })
      );

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      await testWebhook(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.any(String),
        })
      );
    });

    it('should truncate response body to 1KB', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));

      const largeBody = 'x'.repeat(2000);
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue(new Response(largeBody, { status: 200 }));

      await testWebhook(c);

      const [response] = c.json.mock.calls[0];
      expect(response.response_body.length).toBeLessThanOrEqual(1024);
    });

    it('should include custom headers from webhook config', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(
        createWebhookEntry({
          id: 'webhook-123',
          headers: { 'X-Custom-Header': 'custom-value' },
        })
      );

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));

      await testWebhook(c);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Custom-Header': 'custom-value',
          }),
        })
      );
    });
  });
});

// =============================================================================
// List Webhook Deliveries Tests
// =============================================================================

describe('Webhook Admin API - List Deliveries', () => {
  beforeEach(() => {
    resetMocks();
  });

  describe('GET /api/admin/webhooks/:id/deliveries', () => {
    it('should return 400 if webhook ID is missing', async () => {
      const c = createMockContext({
        params: {},
      });

      await listWebhookDeliveries(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_request' }),
        400
      );
    });

    it('should return 404 for non-existent webhook', async () => {
      const c = createMockContext({
        params: { id: 'non-existent' },
      });
      mockWebhookRegistry.get.mockResolvedValue(null);

      await listWebhookDeliveries(c);

      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'not_found' }), 404);
    });

    it('should reject page-based pagination (page parameter)', async () => {
      const c = createMockContext({
        params: { id: 'webhook-123' },
        query: { page: '1' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));

      await listWebhookDeliveries(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('cursor-based pagination'),
        }),
        400
      );
    });

    it('should reject page-based pagination (page_size parameter)', async () => {
      const c = createMockContext({
        params: { id: 'webhook-123' },
        query: { page_size: '10' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));

      await listWebhookDeliveries(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('cursor-based pagination'),
        }),
        400
      );
    });

    it('should reject invalid cursor format', async () => {
      const c = createMockContext({
        params: { id: 'webhook-123' },
        query: { cursor: 'invalid-cursor' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));

      await listWebhookDeliveries(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('Invalid cursor'),
        }),
        400
      );
    });

    it('should limit to maximum 100 results', async () => {
      const c = createMockContext({
        params: { id: 'webhook-123' },
        query: { limit: '200' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));
      mockD1AdapterQuery.mockResolvedValue([]);

      await listWebhookDeliveries(c);

      // The SQL should use 101 (100 + 1 for pagination check)
      expect(mockD1AdapterQuery).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT ?'),
        expect.arrayContaining([101])
      );
    });
  });
});

describe('Webhook Admin API - Get Delivery', () => {
  beforeEach(() => {
    resetMocks();
  });

  describe('GET /api/admin/webhooks/:id/deliveries/:deliveryId', () => {
    it('rejects delivery detail reads without payload permission', async () => {
      const c = createMockContext({
        method: 'GET',
        params: { id: 'webhook-123', deliveryId: 'delivery-123' },
        adminPermissions: ['admin:webhooks:read'],
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));
      mockD1AdapterQueryOne.mockResolvedValue({
        id: 'delivery-123',
        webhook_id: 'webhook-123',
        tenant_id: 'test-tenant',
        event_type: 'user.created',
        event_id: 'event-123',
        status: 'failed',
        status_code: 500,
        request_headers: '{"Authorization":"***MASKED***"}',
        request_body: '{"event":"preview"}',
        response_body: '{"error":"preview"}',
        error_message: 'Boom',
        attempts: 2,
        next_retry_at: null,
        created_at: 1714550400,
        completed_at: 1714550401,
        duration_ms: 250,
        detail_object_catalog_id: 'catalog-123',
        detail_artifact_id: 'oa_test',
      });

      const response = (await getWebhookDelivery(c)) as Response;
      const { body, status } = await getResponseData(response);

      expect(status).toBe(403);
      expect(body.error).toBe('approval_required');
    });

    it('loads externalized request and response payloads from SENSITIVE_DETAILS', async () => {
      const rootKey =
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const objectKey =
        'webhook-deliveries/test-tenant/webhook-123/2026/05/01/delivery-123.json';
      const encryptedPayload = await encryptObjectArtifact(
        JSON.stringify({
          requestHeaders: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
          requestBody: '{"event":"user.created","email":"alice@example.com"}',
          responseBody: '{"ok":true}',
        }),
        {
          rootKeyHex: rootKey,
          plane: 'SENSITIVE_DETAILS',
          keyVersion: 3,
          contentType: 'application/json',
          context: {
            tenantId: 'test-tenant',
            objectKey,
            objectClass: 'webhook_delivery_payload',
          },
        }
      );

      const c = createMockContext({
        method: 'GET',
        params: { id: 'webhook-123', deliveryId: 'delivery-123' },
        sensitiveDetails: createMockBucket({
          [objectKey]: JSON.stringify(encryptedPayload),
        }),
        objectEncryptionRootKey: rootKey,
        objectEncryptionKeyVersion: '3',
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));
      mockD1AdapterQueryOne.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM webhook_deliveries')) {
          return {
            id: 'delivery-123',
            webhook_id: 'webhook-123',
            tenant_id: 'test-tenant',
            event_type: 'user.created',
            event_id: 'event-123',
            status: 'failed',
            status_code: 500,
            request_headers: '{"Authorization":"***MASKED***"}',
            request_body: '{"event":"preview"}',
            response_body: '{"error":"preview"}',
            error_message: 'Boom',
            attempts: 2,
            next_retry_at: null,
            created_at: 1714550400,
            completed_at: 1714550401,
            duration_ms: 250,
            detail_object_catalog_id: 'catalog-123',
            detail_artifact_id: 'oa_test',
          };
        }
        if (sql.includes('FROM object_catalog oc')) {
          expect([
            ['oa_test', 'canonical_json', 0],
            ['catalog-123', 'canonical_json', 0],
          ]).toContainEqual(params);
          return {
            catalog_id: 'catalog-123',
            public_artifact_id: 'oa_test',
            tenant_id: 'test-tenant',
            object_class: 'webhook_delivery_payload',
            catalog_created_at: 1714550400000,
            catalog_updated_at: 1714550400000,
            catalog_deleted_at: null,
            physical_id: 'physical-123',
            representation: 'canonical_json',
            object_kind: 'single',
            object_index: 0,
            bucket_binding: 'SENSITIVE_DETAILS',
            object_key: objectKey,
            key_version: 3,
            checksum_sha256: null,
            total_bytes: 100,
            physical_created_at: 1714550400000,
            physical_deleted_at: null,
          };
        }
        return null;
      });

      const response = (await getWebhookDelivery(c)) as Response;
      const { body, status } = await getResponseData(response);

      expect(status).toBe(200);
      expect(body.delivery.request_headers).toEqual({
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
      });
      expect(body.delivery.request_body).toContain('"alice@example.com"');
      expect(body.delivery.response_body).toBe('{"ok":true}');
      expect(body.delivery.has_detail).toBe(true);
      expect(body.delivery.detail_artifact_id).toBe('oa_test');
    });

    it('allows delivery detail reads with a matching elevation grant', async () => {
      const rootKey =
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const objectKey =
        'webhook-deliveries/test-tenant/webhook-123/2026/05/01/delivery-123.json';
      const encryptedPayload = await encryptObjectArtifact(
        JSON.stringify({
          requestHeaders: { 'Content-Type': 'application/json' },
          requestBody: '{"event":"user.created"}',
          responseBody: '{"ok":true}',
        }),
        {
          rootKeyHex: rootKey,
          plane: 'SENSITIVE_DETAILS',
          keyVersion: 3,
          contentType: 'application/json',
          context: {
            tenantId: 'test-tenant',
            objectKey,
            objectClass: 'webhook_delivery_payload',
          },
        }
      );

      mockGrantRepo.listActiveElevationGrants.mockResolvedValue([
        {
          id: 'grant-1',
          public_grant_id: 'egr_public_1',
          approval_request_id: 'req-1',
          tenant_id: 'test-tenant',
          status: 'active',
          target_audience: 'admin_api',
          resource_class: 'webhook_delivery_payload',
          redaction_level: 'masked',
          scope_canonical: '{"version":1}',
          scope_json: {
            version: 1,
            surface: 'webhook_payload',
            action: 'detail_read',
            tenant_id: 'test-tenant',
            resource_class: 'webhook_delivery_payload',
            resource_ids: ['delivery-123'],
            detail_classes: ['request_response_payload'],
          },
          authorization_details_json: null,
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          actor_subject_type: 'admin_user',
          actor_subject_id: 'admin-1',
          issued_at: Date.now(),
          expires_at: Date.now() + 60000,
          revoked_at: null,
          revoke_reason: null,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ]);

      const c = createMockContext({
        method: 'GET',
        params: { id: 'webhook-123', deliveryId: 'delivery-123' },
        adminPermissions: ['admin:webhooks:read'],
        sensitiveDetails: createMockBucket({
          [objectKey]: JSON.stringify(encryptedPayload),
        }),
        objectEncryptionRootKey: rootKey,
        objectEncryptionKeyVersion: '3',
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));
      mockD1AdapterQueryOne.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM webhook_deliveries')) {
          return {
            id: 'delivery-123',
            webhook_id: 'webhook-123',
            tenant_id: 'test-tenant',
            event_type: 'user.created',
            event_id: 'event-123',
            status: 'failed',
            status_code: 500,
            request_headers: '{"Content-Type":"application/json"}',
            request_body: '{"event":"preview"}',
            response_body: '{"error":"preview"}',
            error_message: 'Boom',
            attempts: 2,
            next_retry_at: null,
            created_at: 1714550400,
            completed_at: 1714550401,
            duration_ms: 250,
            detail_object_catalog_id: 'catalog-123',
            detail_artifact_id: 'oa_test',
          };
        }
        return {
          catalog_id: 'catalog-123',
          public_artifact_id: 'oa_test',
          tenant_id: 'test-tenant',
          object_class: 'webhook_delivery_payload',
          catalog_created_at: 1714550400000,
          catalog_updated_at: 1714550400000,
          catalog_deleted_at: null,
          physical_id: 'physical-123',
          representation: 'canonical_json',
          object_kind: 'single',
          object_index: 0,
          bucket_binding: 'SENSITIVE_DETAILS',
          object_key: objectKey,
          key_version: 3,
          checksum_sha256: null,
          total_bytes: 100,
          physical_created_at: 1714550400000,
          physical_deleted_at: null,
        };
      });

      const response = (await getWebhookDelivery(c)) as Response;
      const { status } = await getResponseData(response);
      expect(status).toBe(200);
    });
  });
});

// =============================================================================
// Replay Webhook Tests
// =============================================================================

describe('Webhook Admin API - Replay Delivery', () => {
  beforeEach(() => {
    resetMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('POST /api/admin/webhooks/:id/replay', () => {
    it('rejects replay without payload permission', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
        body: { delivery_id: 'delivery-123' },
        adminPermissions: ['admin:webhooks:write'],
      });

      const response = (await replayWebhookDelivery(c)) as Response;
      const { body, status } = await getResponseData(response);

      expect(status).toBe(403);
      expect(body.error).toBe('insufficient_permissions');
    });

    it('should return 400 if webhook ID is missing', async () => {
      const c = createMockContext({
        method: 'POST',
        params: {},
        body: { delivery_id: 'delivery-123' },
      });

      await replayWebhookDelivery(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_request' }),
        400
      );
    });

    it('should return 400 if delivery_id is missing', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
        body: {},
      });

      await replayWebhookDelivery(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('delivery_id'),
        }),
        400
      );
    });

    it('should return 404 for non-existent webhook', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'non-existent' },
        body: { delivery_id: 'delivery-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(null);

      await replayWebhookDelivery(c);

      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'not_found' }), 404);
    });

    it('should only allow replay of failed or retrying deliveries', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
        body: { delivery_id: 'delivery-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));
      mockD1AdapterQueryOne.mockResolvedValue({
        id: 'delivery-123',
        webhook_id: 'webhook-123',
        tenant_id: 'test-tenant',
        status: 'success',
        request_body: '{}',
      });

      await replayWebhookDelivery(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining(
            "Cannot replay delivery with status 'success'"
          ),
        }),
        400
      );
    });

    it('should add X-Webhook-Replay header to replay request', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
        body: { delivery_id: 'delivery-123' },
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));
      mockD1AdapterQueryOne.mockResolvedValue({
        id: 'delivery-123',
        webhook_id: 'webhook-123',
        tenant_id: 'test-tenant',
        event_type: 'user.created',
        event_id: 'event-123',
        status: 'failed',
        request_body: '{"event":"user.created"}',
        attempts: 3,
      });
      mockD1AdapterExecute.mockResolvedValue({ success: true });

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));

      await replayWebhookDelivery(c);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Webhook-Replay': 'true',
          }),
        })
      );
    });

    it('replays from externalized delivery payloads and stores pointer-backed previews', async () => {
      const rootKey =
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const objectKey =
        'webhook-deliveries/test-tenant/webhook-123/2026/05/01/delivery-123.json';
      const encryptedPayload = await encryptObjectArtifact(
        JSON.stringify({
          requestHeaders: { 'Content-Type': 'application/json' },
          requestBody: '{"event":"user.created","user_id":"user-1"}',
          responseBody: null,
        }),
        {
          rootKeyHex: rootKey,
          plane: 'SENSITIVE_DETAILS',
          keyVersion: 2,
          contentType: 'application/json',
          context: {
            tenantId: 'test-tenant',
            objectKey,
            objectClass: 'webhook_delivery_payload',
          },
        }
      );

      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
        body: { delivery_id: 'delivery-123' },
        sensitiveDetails: createMockBucket({
          [objectKey]: JSON.stringify(encryptedPayload),
        }),
        objectEncryptionRootKey: rootKey,
        objectEncryptionKeyVersion: '2',
      });
      mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({ id: 'webhook-123' }));
      mockD1AdapterQueryOne.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM webhook_deliveries')) {
          return {
            id: 'delivery-123',
            webhook_id: 'webhook-123',
            tenant_id: 'test-tenant',
            event_type: 'user.created',
            event_id: 'event-123',
            status: 'failed',
            request_headers: '{"Content-Type":"application/json"}',
            request_body: '{"event":"preview"}',
            response_body: null,
            attempts: 3,
            detail_object_catalog_id: 'catalog-123',
            detail_artifact_id: 'oa_test',
            created_at: 1714550400,
            completed_at: null,
            next_retry_at: null,
            duration_ms: null,
            status_code: null,
            error_message: null,
          };
        }
        if (sql.includes('FROM object_catalog oc')) {
          return {
            catalog_id: 'catalog-123',
            public_artifact_id: 'oa_test',
            tenant_id: 'test-tenant',
            object_class: 'webhook_delivery_payload',
            catalog_created_at: 1714550400000,
            catalog_updated_at: 1714550400000,
            catalog_deleted_at: null,
            physical_id: 'physical-123',
            representation: 'canonical_json',
            object_kind: 'single',
            object_index: 0,
            bucket_binding: 'SENSITIVE_DETAILS',
            object_key: objectKey,
            key_version: 2,
            checksum_sha256: null,
            total_bytes: 100,
            physical_created_at: 1714550400000,
            physical_deleted_at: null,
          };
        }
        return null;
      });
      mockD1AdapterExecute.mockResolvedValue({ success: true });

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));

      await replayWebhookDelivery(c);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"user_id":"user-1"'),
        })
      );
      expect(mockD1AdapterExecute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO object_catalog'),
        expect.any(Array)
      );
      expect(mockD1AdapterExecute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO webhook_deliveries'),
        expect.arrayContaining([
          expect.any(String),
        ])
      );
      const deliveryInsert = mockD1AdapterExecute.mock.calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('INSERT INTO webhook_deliveries')
      );
      expect(deliveryInsert?.[1]?.[7]).toContain('"X-Webhook-Replay":"true"');
      expect(deliveryInsert?.[1]?.[8]).toContain('"event":"user.created"');
      expect(deliveryInsert?.[1]?.[13]).toEqual(expect.any(String));
    });

    it('should generate new signature for replay', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'webhook-123' },
        body: { delivery_id: 'delivery-123' },
        piiEncryptionKey: 'test-key-32-characters-long-xxx',
      });
      mockWebhookRegistry.get.mockResolvedValue(
        createWebhookEntry({ id: 'webhook-123', secretEncrypted: 'encrypted-secret' })
      );
      mockDecryptValue.mockResolvedValue({ decrypted: 'my-secret' });

      // Use the hoisted D1Adapter mock
      mockD1AdapterQueryOne.mockResolvedValue({
        id: 'delivery-123',
        webhook_id: 'webhook-123',
        tenant_id: 'test-tenant',
        event_type: 'user.created',
        event_id: 'event-123',
        status: 'failed',
        request_body: '{"event":"user.created"}',
        attempts: 3,
      });
      mockD1AdapterExecute.mockResolvedValue({ success: true });

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));

      await replayWebhookDelivery(c);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Webhook-Signature': expect.stringMatching(/^sha256=[a-f0-9]+$/),
          }),
        })
      );
    });
  });
});

// =============================================================================
// Security Tests - HMAC Signature
// =============================================================================

describe('Webhook Security - HMAC Signature', () => {
  beforeEach(() => {
    resetMocks();
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(fetch).mockResolvedValue(new Response('OK', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should generate deterministic signature for same payload and secret', async () => {
    const c1 = createMockContext({
      method: 'POST',
      params: { id: 'webhook-123' },
      piiEncryptionKey: 'test-key-32-characters-long-xxx',
    });
    const c2 = createMockContext({
      method: 'POST',
      params: { id: 'webhook-123' },
      piiEncryptionKey: 'test-key-32-characters-long-xxx',
    });

    mockWebhookRegistry.get.mockResolvedValue(
      createWebhookEntry({ id: 'webhook-123', secretEncrypted: 'encrypted-secret' })
    );
    mockDecryptValue.mockResolvedValue({ decrypted: 'same-secret' });

    // Mock consistent timestamp
    const fixedTimestamp = '2024-01-01T00:00:00.000Z';
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(fixedTimestamp);

    await testWebhook(c1);
    await testWebhook(c2);

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBe(2);

    // Extract signatures
    const signature1 = (calls[0][1] as RequestInit).headers?.[
      'X-Webhook-Signature' as keyof HeadersInit
    ];
    const signature2 = (calls[1][1] as RequestInit).headers?.[
      'X-Webhook-Signature' as keyof HeadersInit
    ];

    // Same secret should produce same signature for same payload
    expect(signature1).toBe(signature2);
  });

  it('should produce different signatures with different secrets', async () => {
    const c = createMockContext({
      method: 'POST',
      params: { id: 'webhook-123' },
      piiEncryptionKey: 'test-key-32-characters-long-xxx',
    });

    // First call with secret1
    mockWebhookRegistry.get.mockResolvedValue(
      createWebhookEntry({ id: 'webhook-123', secretEncrypted: 'encrypted-1' })
    );
    mockDecryptValue.mockResolvedValueOnce({ decrypted: 'secret-one' });

    await testWebhook(c);

    // Second call with secret2
    mockWebhookRegistry.get.mockResolvedValue(
      createWebhookEntry({ id: 'webhook-123', secretEncrypted: 'encrypted-2' })
    );
    mockDecryptValue.mockResolvedValueOnce({ decrypted: 'secret-two' });

    await testWebhook(c);

    const calls = vi.mocked(fetch).mock.calls;
    const signature1 = (calls[0][1] as RequestInit).headers?.[
      'X-Webhook-Signature' as keyof HeadersInit
    ];
    const signature2 = (calls[1][1] as RequestInit).headers?.[
      'X-Webhook-Signature' as keyof HeadersInit
    ];

    expect(signature1).not.toBe(signature2);
  });

  it('should use sha256 prefix in signature format', async () => {
    const c = createMockContext({
      method: 'POST',
      params: { id: 'webhook-123' },
      piiEncryptionKey: 'test-key-32-characters-long-xxx',
    });

    mockWebhookRegistry.get.mockResolvedValue(
      createWebhookEntry({ id: 'webhook-123', secretEncrypted: 'encrypted-secret' })
    );
    mockDecryptValue.mockResolvedValue({ decrypted: 'my-secret' });

    await testWebhook(c);

    const calls = vi.mocked(fetch).mock.calls;
    const signature = (calls[0][1] as RequestInit).headers?.[
      'X-Webhook-Signature' as keyof HeadersInit
    ];

    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});

// =============================================================================
// Security Tests - Secret Non-Exposure
// =============================================================================

describe('Webhook Security - Secret Non-Exposure', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('should not expose secret in createWebhook response', async () => {
    const c = createMockContext({
      method: 'POST',
      body: {
        name: 'My Webhook',
        url: 'https://example.com/webhook',
        events: ['user.created'],
        secret: 'super-secret-key',
      },
    });

    mockValidateEventPattern.mockReturnValue({ valid: true });
    mockWebhookRegistry.register.mockResolvedValue('webhook-123');
    mockWebhookRegistry.get.mockResolvedValue(
      createWebhookEntry({ id: 'webhook-123', secretEncrypted: 'encrypted-secret' })
    );

    await createWebhook(c);

    const [response] = c.json.mock.calls[0];
    expect(response.webhook.secret).toBeUndefined();
    expect(response.webhook.secretEncrypted).toBeUndefined();
  });

  it('should not expose secret in listWebhooks response', async () => {
    const c = createMockContext({});
    mockWebhookRegistry.list.mockResolvedValue([
      createWebhookEntry({ secretEncrypted: 'encrypted-1' }),
      createWebhookEntry({ secretEncrypted: 'encrypted-2' }),
    ]);

    await listWebhooks(c);

    const [response] = c.json.mock.calls[0];
    for (const webhook of response.webhooks) {
      expect(webhook.secret).toBeUndefined();
      expect(webhook.secretEncrypted).toBeUndefined();
    }
  });

  it('should not expose secret in getWebhook response', async () => {
    const c = createMockContext({
      params: { id: 'webhook-123' },
    });
    mockWebhookRegistry.get.mockResolvedValue(
      createWebhookEntry({ secretEncrypted: 'encrypted-secret' })
    );

    await getWebhook(c);

    const [response] = c.json.mock.calls[0];
    expect(response.webhook.secret).toBeUndefined();
    expect(response.webhook.secretEncrypted).toBeUndefined();
  });

  it('should not expose secret in updateWebhook response', async () => {
    const c = createMockContext({
      method: 'PUT',
      params: { id: 'webhook-123' },
      body: { name: 'Updated' },
    });

    mockValidateEventPattern.mockReturnValue({ valid: true });
    mockWebhookRegistry.get
      .mockResolvedValueOnce(createWebhookEntry({ secretEncrypted: 'encrypted-secret' }))
      .mockResolvedValueOnce(createWebhookEntry({ secretEncrypted: 'encrypted-secret' }));
    mockWebhookRegistry.update.mockResolvedValue(undefined);

    await updateWebhook(c);

    const [response] = c.json.mock.calls[0];
    expect(response.webhook.secret).toBeUndefined();
    expect(response.webhook.secretEncrypted).toBeUndefined();
  });
});

// =============================================================================
// Security Tests - Tenant Isolation
// =============================================================================

describe('Webhook Security - Tenant Isolation', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('should enforce tenant isolation on get', async () => {
    mockGetTenantIdFromContext.mockReturnValue('tenant-a');
    const c = createMockContext({
      params: { id: 'webhook-123' },
      tenantId: 'tenant-a',
    });

    // Webhook registry returns null because it filters by tenant
    mockWebhookRegistry.get.mockResolvedValue(null);

    await getWebhook(c);

    expect(mockWebhookRegistry.get).toHaveBeenCalledWith('tenant-a', 'webhook-123');
    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'not_found' }), 404);
  });

  it('should enforce tenant isolation on update', async () => {
    mockGetTenantIdFromContext.mockReturnValue('tenant-a');
    const c = createMockContext({
      method: 'PUT',
      params: { id: 'webhook-123' },
      body: { name: 'Updated' },
      tenantId: 'tenant-a',
    });

    mockWebhookRegistry.get.mockResolvedValue(null);

    await updateWebhook(c);

    expect(mockWebhookRegistry.get).toHaveBeenCalledWith('tenant-a', 'webhook-123');
    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'not_found' }), 404);
  });

  it('should enforce tenant isolation on delete', async () => {
    mockGetTenantIdFromContext.mockReturnValue('tenant-a');
    const c = createMockContext({
      method: 'DELETE',
      params: { id: 'webhook-123' },
      tenantId: 'tenant-a',
    });

    mockWebhookRegistry.get.mockResolvedValue(null);

    await deleteWebhook(c);

    expect(mockWebhookRegistry.get).toHaveBeenCalledWith('tenant-a', 'webhook-123');
    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'not_found' }), 404);
  });

  it('should enforce tenant isolation on list', async () => {
    mockGetTenantIdFromContext.mockReturnValue('tenant-a');
    const c = createMockContext({
      tenantId: 'tenant-a',
    });

    mockWebhookRegistry.list.mockResolvedValue([]);

    await listWebhooks(c);

    expect(mockWebhookRegistry.list).toHaveBeenCalledWith('tenant-a', expect.any(Object));
  });
});

// =============================================================================
// Event Pattern Validation Tests
// =============================================================================

describe('Webhook Event Pattern Validation', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('should accept valid event pattern', async () => {
    mockValidateEventPattern.mockReturnValue({ valid: true });

    const c = createMockContext({
      method: 'POST',
      body: {
        name: 'My Webhook',
        url: 'https://example.com/webhook',
        events: ['user.created'],
      },
    });

    mockWebhookRegistry.register.mockResolvedValue('webhook-123');
    mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({}));

    await createWebhook(c);

    expect(mockValidateEventPattern).toHaveBeenCalledWith('user.created');
    const [, status] = c.json.mock.calls[0];
    expect(status).toBe(201);
  });

  it('should accept wildcard event patterns', async () => {
    mockValidateEventPattern.mockReturnValue({ valid: true });

    const c = createMockContext({
      method: 'POST',
      body: {
        name: 'My Webhook',
        url: 'https://example.com/webhook',
        events: ['user.*'],
      },
    });

    mockWebhookRegistry.register.mockResolvedValue('webhook-123');
    mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({}));

    await createWebhook(c);

    expect(mockValidateEventPattern).toHaveBeenCalledWith('user.*');
  });

  it('should reject patterns that could cause ReDoS', async () => {
    mockValidateEventPattern.mockReturnValue({
      valid: false,
      error: 'Pattern contains dangerous regex constructs',
    });

    const c = createMockContext({
      method: 'POST',
      body: {
        name: 'My Webhook',
        url: 'https://example.com/webhook',
        events: ['((a+)+)'],
      },
    });

    await createWebhook(c);

    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'invalid_request',
        error_description: expect.stringContaining('Invalid event pattern'),
      }),
      400
    );
  });

  it('should validate all events in the array', async () => {
    mockValidateEventPattern
      .mockReturnValueOnce({ valid: true })
      .mockReturnValueOnce({ valid: false, error: 'Invalid' });

    const c = createMockContext({
      method: 'POST',
      body: {
        name: 'My Webhook',
        url: 'https://example.com/webhook',
        events: ['user.created', 'invalid..pattern'],
      },
    });

    await createWebhook(c);

    expect(mockValidateEventPattern).toHaveBeenCalledTimes(2);
    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_request' }), 400);
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Webhook API - Error Handling', () => {
  beforeEach(() => {
    resetMocks();
    mockValidateEventPattern.mockReturnValue({ valid: true });
  });

  it('should handle registry.register errors gracefully', async () => {
    const c = createMockContext({
      method: 'POST',
      body: {
        name: 'My Webhook',
        url: 'https://example.com/webhook',
        events: ['user.created'],
      },
    });

    mockWebhookRegistry.register.mockRejectedValue(new Error('Database error'));

    await createWebhook(c);

    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'server_error' }), 500);
  });

  it('should handle registry.list errors gracefully', async () => {
    const c = createMockContext({});

    mockWebhookRegistry.list.mockRejectedValue(new Error('Database error'));

    await listWebhooks(c);

    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'server_error' }), 500);
  });

  it('should handle registry.get errors gracefully', async () => {
    const c = createMockContext({
      params: { id: 'webhook-123' },
    });

    mockWebhookRegistry.get.mockRejectedValue(new Error('Database error'));

    await getWebhook(c);

    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'server_error' }), 500);
  });

  it('should handle registry.update errors gracefully', async () => {
    const c = createMockContext({
      method: 'PUT',
      params: { id: 'webhook-123' },
      body: { name: 'Updated' },
    });

    mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({}));
    mockWebhookRegistry.update.mockRejectedValue(new Error('Database error'));

    await updateWebhook(c);

    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'server_error' }), 500);
  });

  it('should handle registry.remove errors gracefully', async () => {
    const c = createMockContext({
      method: 'DELETE',
      params: { id: 'webhook-123' },
    });

    mockWebhookRegistry.get.mockResolvedValue(createWebhookEntry({}));
    mockWebhookRegistry.remove.mockRejectedValue(new Error('Database error'));

    await deleteWebhook(c);

    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'server_error' }), 500);
  });
});
