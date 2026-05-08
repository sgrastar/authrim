/**
 * Admin API Handlers Unit Tests
 *
 * Tests for Admin API endpoints including:
 * - Statistics (adminStatsHandler)
 * - User management (CRUD operations)
 * - Client management (CRUD operations)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const { mockPostgresAdapterFactory } = vi.hoisted(() => ({
  mockPostgresAdapterFactory: vi.fn(),
}));

// Mock specific submodules to avoid ESM barrel export resolution issues
// Vite's barrel export resolution can't handle deep `export *` chains with vi.spyOn,
// so we mock the specific source modules directly.
vi.mock('@authrim/ar-lib-core/utils/audit-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core/utils/audit-log')>();
  return {
    ...actual,
    scheduleAuditLogFromContext: vi.fn(() => {}),
  };
});
vi.mock('@authrim/ar-lib-core/utils/id', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core/utils/id')>();
  return {
    ...actual,
    generateUserIdFromSettings: vi.fn(
      async () => `user-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
    ),
  };
});
vi.mock('@authrim/ar-lib-core/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core/utils/crypto')>();
  return {
    ...actual,
    hashClientSecret: vi.fn(async (secret: string) => {
      // Simple hash mock for testing - return hex string of consistent length
      const encoder = new TextEncoder();
      const data = encoder.encode(secret);
      const hashBuffer = await (globalThis as unknown as { crypto: Crypto }).crypto.subtle.digest(
        'SHA-256',
        data
      );
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    }),
  };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(async (env: Partial<Env>) => ({
      storageProfile: {
        id: 'builtin:storage:standard',
        kind: 'storage',
        label: 'Standard D1 Split',
        slices: {},
      },
      schemaDb: env.DB,
      nonPiiDb: env.DB,
      piiDb: env.DB_PII ?? null,
    })),
    resolveTenantRuntimeProfilesFromEnv: vi.fn(async (env: Partial<Env>) => {
      const auditProfileId = (env as Record<string, unknown>).DEFAULT_AUDIT_PROFILE_ID;
      if (auditProfileId === 'builtin:audit:archive-only-logpush') {
        return {
          auditProfile: {
            id: 'builtin:audit:archive-only-logpush',
            kind: 'audit',
            label: 'Archive Only + Logpush',
            builtin: true,
            primary: null,
            archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
            sinks: [],
          },
        };
      }
      if (auditProfileId === 'custom:audit:postgres-primary') {
        return {
          auditProfile: {
            id: 'custom:audit:postgres-primary',
            kind: 'audit',
            label: 'Postgres Primary',
            builtin: false,
            primary: { type: 'postgres', connectionRef: 'audit-primary', dataset: 'event_log' },
            archive: null,
            sinks: [],
          },
        };
      }
      return {
        auditProfile: {
          id: 'builtin:audit:standard',
          kind: 'audit',
          label: 'Standard Audit',
          builtin: true,
          primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
          archive: null,
          sinks: [],
        },
      };
    }),
    PostgresAdapter: vi.fn().mockImplementation(function MockPostgresAdapter(config: unknown) {
      const adapter = mockPostgresAdapterFactory(config);
      if (!adapter) {
        throw new Error('mockPostgresAdapterFactory returned no adapter');
      }
      return adapter;
    }),
    MysqlAdapter: vi.fn().mockImplementation(function MockMysqlAdapter(config: unknown) {
      const adapter = mockPostgresAdapterFactory(config);
      if (!adapter) {
        throw new Error('mockPostgresAdapterFactory returned no adapter');
      }
      return adapter;
    }),
    createExternalAuditDatabaseAdapter: vi.fn((env: unknown, target: unknown, partition: unknown) =>
      mockPostgresAdapterFactory({ env, target, partition })
    ),
  };
});

import {
  adminStatsHandler,
  adminUsersListHandler,
  adminUserGetHandler,
  adminUserCreateHandler,
  adminUserUpdateHandler,
  adminUserDeleteHandler,
  adminUserAnonymizeHandler,
  adminUserSendEmailHandler,
  adminAuditLogListHandler,
  adminAuditLogGetHandler,
  adminUserActivityLogHandler,
  adminClientsListHandler,
  adminClientGetHandler,
  adminClientCreateHandler,
  adminClientUpdateHandler,
  adminClientDeleteHandler,
  adminClientRegenerateSecretHandler,
} from '../admin';

// Helper to create mock D1Database
function createMockDB(options: {
  prepareResults?: Record<string, any>;
  allResults?: any[];
  firstResult?: any;
  runResult?: { success: boolean };
}) {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(options.firstResult ?? null),
    all: vi.fn().mockResolvedValue({ results: options.allResults ?? [] }),
    run: vi.fn().mockResolvedValue(options.runResult ?? { success: true }),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    _mockStatement: mockStatement,
  } as unknown as D1Database & { _mockStatement: typeof mockStatement };
}

function createSqlAwareMockDB(
  handler: (
    sql: string,
    params: unknown[],
    op: 'first' | 'all' | 'run'
  ) => unknown | Promise<unknown>
) {
  return {
    prepare: vi.fn((sql: string) => {
      let boundParams: unknown[] = [];
      const statement = {
        bind: vi.fn((...params: unknown[]) => {
          boundParams = params;
          return statement;
        }),
        first: vi.fn(async () => (await handler(sql, boundParams, 'first')) ?? null),
        all: vi.fn(async () => ({
          results: ((await handler(sql, boundParams, 'all')) ?? []) as any[],
        })),
        run: vi.fn(async () => (await handler(sql, boundParams, 'run')) ?? { success: true }),
      };
      return statement;
    }),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  } as unknown as D1Database;
}

// Mock KV namespace for cache invalidation
function createMockKVNamespace(initialData: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initialData));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn().mockResolvedValue({ keys: [] }),
  };
}

// Helper to create mock context
function createMockContext(options: {
  method?: string;
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  db?: D1Database;
  dbPII?: D1Database;
  headers?: Record<string, string>;
  jsonError?: Error;
  envOverrides?: Partial<Env>;
}) {
  const mockDB =
    options.db ??
    createMockDB({
      firstResult: null,
      allResults: [],
    });

  // DB_PII mock for PII/Non-PII DB separation
  const mockDBPII =
    options.dbPII ??
    createMockDB({
      firstResult: null,
      allResults: [],
    });

  // Store context values (simulating Hono's context store)
  const contextStore = new Map<string, unknown>([
    ['tenantId', 'default'],
    [
      'adminAuth',
      {
        userId: 'admin-user',
        email: 'admin@example.com',
        sessionId: 'session-123',
        roles: ['system_admin'],
        permissions: [],
      },
    ],
  ]);
  const normalizedHeaders = new Map(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  const responseHeaders = new Map<string, string>();

  const c = {
    req: {
      method: options.method || 'GET',
      query: (name: string) => options.query?.[name],
      param: (name: string) => options.params?.[name],
      json: options.jsonError
        ? vi.fn().mockRejectedValue(options.jsonError)
        : vi.fn().mockResolvedValue(options.body ?? {}),
      parseBody: vi.fn().mockResolvedValue(options.body ?? {}),
      header: vi.fn((name: string) => normalizedHeaders.get(name.toLowerCase())),
    },
    env: {
      DB: mockDB,
      DB_PII: mockDBPII, // Added for PII/Non-PII DB separation
      ISSUER_URL: 'https://op.example.com',
      CLIENTS_CACHE: createMockKVNamespace(),
      SETTINGS: createMockKVNamespace(),
    } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    header: vi.fn((name: string, value: string) => {
      responseHeaders.set(name, value);
    }),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
    executionCtx: {
      waitUntil: vi.fn(),
    },
    _mockDB: mockDB,
    _mockDBPII: mockDBPII, // For test assertions
    _responseHeaders: responseHeaders,
  } as any;

  c.env = {
    ...c.env,
    ...options.envOverrides,
  };

  return c;
}

function createMockR2Bucket(
  entries: Array<{
    key: string;
    body: unknown;
  }>
): R2Bucket {
  const objects = entries.map((entry) => ({
    key: entry.key,
    size: JSON.stringify(entry.body).length,
    uploaded: new Date(),
    etag: `etag-${entry.key}`,
    checksums: {},
    httpEtag: `etag-${entry.key}`,
    version: 'v1',
  })) as unknown as R2Object[];

  return {
    list: vi.fn(async ({ prefix }: { prefix?: string }) => ({
      objects: prefix ? objects.filter((object) => object.key.startsWith(prefix)) : objects,
      truncated: false,
      delimitedPrefixes: [],
    })),
    get: vi.fn(async (key: string) => {
      const found = entries.find((entry) => entry.key === key);
      if (!found) {
        return null;
      }
      return {
        text: async () => JSON.stringify(found.body),
      };
    }),
  } as unknown as R2Bucket;
}

function createCustomClaimSchemaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'schema-1',
    tenant_id: 'default',
    field_key: 'department',
    display_label: 'Department',
    field_type: 'string',
    is_pii: 0,
    is_required: 1,
    is_active: 1,
    validation_rules: null,
    include_in_id_token: 0,
    include_in_userinfo: 0,
    include_in_introspection: 0,
    required_scopes: null,
    scope_mode: 'any',
    is_searchable: 1,
    is_exportable: 1,
    is_vc_claim: 0,
    claim_namespace: null,
    description: null,
    display_order: 0,
    schema_version: 1,
    operation_status: 'active',
    operation_detail: null,
    created_by: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

describe('Admin API Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostgresAdapterFactory.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('adminStatsHandler', () => {
    it('should return statistics with correct structure', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 10 },
        allResults: [
          { id: 'user-1', email: 'user1@example.com', name: 'User 1', created_at: Date.now() },
        ],
      });

      const c = createMockContext({ db: mockDB });

      await adminStatsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          stats: expect.objectContaining({
            activeUsers: expect.any(Number),
            totalUsers: expect.any(Number),
            registeredClients: expect.any(Number),
            newUsersToday: expect.any(Number),
            loginsToday: expect.any(Number),
          }),
          recentActivity: expect.any(Array),
        })
      );
    });

    it('should include active users count from last 30 days', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 25 },
        allResults: [],
      });

      const c = createMockContext({ db: mockDB });

      await adminStatsHandler(c);

      // Verify the query for active users was made
      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('last_login_at'));
    });

    it('should include recent activity in response', async () => {
      const now = Date.now();
      // Core DB returns user IDs and timestamps (no PII)
      const mockDB = createMockDB({
        firstResult: { count: 5 },
        allResults: [
          { id: 'user-1', created_at: now },
          { id: 'user-2', created_at: now - 1000 },
        ],
      });

      // PII DB returns email and name for the user IDs
      const mockDBPII = createMockDB({
        allResults: [
          { id: 'user-1', email: 'new@example.com', name: 'New User' },
          { id: 'user-2', email: 'another@example.com', name: 'Another' },
        ],
      });

      const c = createMockContext({ db: mockDB, dbPII: mockDBPII });

      await adminStatsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          recentActivity: expect.arrayContaining([
            expect.objectContaining({
              type: 'user_registration',
              userId: 'user-1',
              email: 'new@example.com',
            }),
          ]),
        })
      );
    });

    it('should handle database errors gracefully', async () => {
      const mockDB = createMockDB({});
      (mockDB as any)._mockStatement.first.mockRejectedValue(new Error('DB connection failed'));

      const c = createMockContext({ db: mockDB });

      await adminStatsHandler(c);

      // D1Adapter returns null on failure after retries (graceful degradation)
      // Handler converts null to zeros instead of throwing error
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          stats: expect.objectContaining({
            activeUsers: 0,
            totalUsers: 0,
            registeredClients: 0,
            newUsersToday: 0,
            loginsToday: 0,
          }),
          recentActivity: [],
        })
      );
    });
  });

  describe('archive-only audit hot query guard', () => {
    it('returns archive-backed audit log entries when archive-only profile is active', async () => {
      const archiveBucket = createMockR2Bucket([
        {
          key: 'audit/event/default/2026-04-30/evt-1.json',
          body: {
            id: 'evt-1',
            tenantId: 'default',
            eventType: 'user.login',
            eventCategory: 'auth',
            result: 'success',
            severity: 'info',
            clientId: 'client-1',
            detailsJson: JSON.stringify({
              resourceType: 'user',
              resourceId: 'user-1',
              ipAddress: '127.0.0.1',
            }),
            createdAt: Date.parse('2026-04-30T00:00:00.000Z'),
          },
        },
      ]);
      const c = createMockContext({
        envOverrides: {
          DEFAULT_AUDIT_PROFILE_ID: 'builtin:audit:archive-only-logpush',
          DIAGNOSTIC_LOGS: archiveBucket,
        } as Partial<Env>,
      });

      const response = await adminAuditLogListHandler(c);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        entries: Array<Record<string, unknown>>;
        pagination: { total: number };
      };
      expect(body.pagination.total).toBe(1);
      expect(body.entries).toEqual([
        expect.objectContaining({
          id: 'evt-1',
          action: 'user.login',
          resourceType: 'user',
          resourceId: 'user-1',
          ipAddress: '127.0.0.1',
        }),
      ]);
    });

    it('returns archive-backed audit log details when archive-only profile is active', async () => {
      const archiveBucket = createMockR2Bucket([
        {
          key: 'audit/event/default/2026-04-30/evt-1.json',
          body: {
            id: 'evt-1',
            tenantId: 'default',
            eventType: 'user.login',
            eventCategory: 'auth',
            result: 'success',
            severity: 'info',
            requestId: 'req-1',
            detailsJson: JSON.stringify({
              resourceType: 'user',
              resourceId: 'user-1',
              userAgent: 'Vitest',
            }),
            createdAt: Date.parse('2026-04-30T00:00:00.000Z'),
          },
        },
      ]);
      const c = createMockContext({
        params: { id: 'evt-1' },
        envOverrides: {
          DEFAULT_AUDIT_PROFILE_ID: 'builtin:audit:archive-only-logpush',
          DIAGNOSTIC_LOGS: archiveBucket,
        } as Partial<Env>,
      });

      const response = await adminAuditLogGetHandler(c);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual(
        expect.objectContaining({
          id: 'evt-1',
          action: 'user.login',
          resourceType: 'user',
          resourceId: 'user-1',
          requestId: 'req-1',
          userAgent: 'Vitest',
        })
      );
    });

    it('returns pending_runtime_support for non-D1 primary audit profiles', async () => {
      const c = createMockContext({
        envOverrides: {
          DEFAULT_AUDIT_PROFILE_ID: 'custom:audit:postgres-primary',
        } as Partial<Env>,
      });

      const response = await adminAuditLogListHandler(c);
      expect(response.status).toBe(501);
      const body = (await response.json()) as {
        error: string;
        profile_id: string;
        hot_query_status: string;
      };
      expect(body.error).toBe('not_supported');
      expect(body.profile_id).toBe('custom:audit:postgres-primary');
      expect(body.hot_query_status).toBe('pending_runtime_support');
    });
  });

  describe('adminUserActivityLogHandler', () => {
    it('reads unified event_log entries using current schema columns', async () => {
      const mockDB = createSqlAwareMockDB(async (sql, params, op) => {
        if (sql.includes('SELECT id FROM users_core')) {
          return { id: 'user-1' };
        }

        if (sql.includes('FROM event_log') && op === 'all') {
          expect(sql).toContain('anonymized_user_id = ?');
          expect(sql).toContain('details_json as details');
          expect(params).toContain('anon-user-1');
          return [
            {
              id: 'audit-1',
              action: 'auth.login',
              details: JSON.stringify({ method: 'passkey' }),
              created_at: 1710000000000,
              ip_address: '127.0.0.1',
              user_agent: 'Vitest',
            },
          ];
        }

        if (sql.includes('SELECT anonymized_user_id FROM user_anonymization_map')) {
          return { anonymized_user_id: 'anon-user-1' };
        }

        return null;
      });

      const c = createMockContext({
        params: { id: 'user-1' },
        db: mockDB,
        dbPII: mockDB,
      });

      const response = await adminUserActivityLogHandler(c);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: Array<{
          action: string;
          details: Record<string, unknown>;
          ip_address: string | null;
        }>;
      };

      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        action: 'auth.login',
        details: expect.objectContaining({ method: 'passkey' }),
        ip_address: '127.0.0.1',
        user_agent: 'Vitest',
      });
    });
  });

  describe('adminUsersListHandler', () => {
    it('should return paginated users list', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 50 },
        allResults: [
          {
            id: 'user-1',
            email: 'user1@example.com',
            name: 'User One',
            email_verified: 1,
            phone_number_verified: 0,
            created_at: Date.now(),
            updated_at: Date.now(),
            last_login_at: null,
          },
          {
            id: 'user-2',
            email: 'user2@example.com',
            name: 'User Two',
            email_verified: 1,
            phone_number_verified: 1,
            created_at: Date.now(),
            updated_at: Date.now(),
            last_login_at: Date.now(),
          },
        ],
      });

      const c = createMockContext({
        query: { page: '1', limit: '20' },
        db: mockDB,
      });

      await adminUsersListHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          users: expect.any(Array),
          pagination: expect.objectContaining({
            page: 1,
            limit: 20,
            total: 50,
            totalPages: 3,
            hasNext: true,
            hasPrev: false,
          }),
        })
      );
    });

    it('should support search filtering by email or name', async () => {
      // PII/Non-PII DB Separation:
      // 1. Search queries PII DB first to get matching user IDs
      // 2. Core DB is queried for user_core data with those IDs
      // 3. PII DB is queried again for full PII data

      // Core DB returns user core data (no PII)
      const mockDB = createMockDB({
        firstResult: { count: 1 },
        allResults: [
          {
            id: 'user-1',
            tenant_id: 'default',
            email_verified: 1,
            phone_number_verified: 0,
            is_active: 1,
            user_type: 'end_user',
            pii_partition: 'default',
            pii_status: 'active',
            created_at: Date.now(),
            updated_at: Date.now(),
            last_login_at: null,
          },
        ],
      });

      // PII DB returns IDs for search (first call) and full PII data (second call)
      const mockDBPII = createMockDB({
        allResults: [
          {
            id: 'user-1',
            email: 'john@example.com',
            name: 'John Doe',
          },
        ],
      });

      const c = createMockContext({
        query: { search: 'john' },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUsersListHandler(c);

      // Verify search was applied on PII DB
      expect(mockDBPII.prepare).toHaveBeenCalledWith(expect.stringContaining('LIKE'));
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          users: expect.arrayContaining([
            expect.objectContaining({
              email: 'john@example.com',
            }),
          ]),
        })
      );
    });

    it('should support verified filtering', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 30 },
        allResults: [],
      });

      const c = createMockContext({
        query: { verified: 'true' },
        db: mockDB,
      });

      await adminUsersListHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('email_verified'));
    });

    it('should include pagination metadata', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 100 },
        allResults: [],
      });

      const c = createMockContext({
        query: { page: '3', limit: '10' },
        db: mockDB,
      });

      await adminUsersListHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pagination: expect.objectContaining({
            page: 3,
            limit: 10,
            total: 100,
            totalPages: 10,
            hasNext: true,
            hasPrev: true,
          }),
        })
      );
    });

    it('should convert boolean fields correctly', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 1 },
        allResults: [
          {
            id: 'user-1',
            email: 'test@example.com',
            name: 'Test User',
            email_verified: 1,
            phone_number_verified: 0,
            created_at: Date.now(),
            updated_at: Date.now(),
            last_login_at: null,
          },
        ],
      });

      const c = createMockContext({ db: mockDB });

      await adminUsersListHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          users: expect.arrayContaining([
            expect.objectContaining({
              email_verified: true,
              phone_number_verified: false,
            }),
          ]),
        })
      );
    });

    it('should support lifecycle_state filtering and include it in results', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 1 },
        allResults: [
          {
            id: 'user-1',
            tenant_id: 'default',
            email_verified: 1,
            phone_number_verified: 0,
            is_active: 1,
            user_type: 'end_user',
            pii_partition: 'default',
            pii_status: 'active',
            lifecycle_state: 'incomplete',
            created_at: Date.now(),
            updated_at: Date.now(),
            last_login_at: null,
          },
        ],
      });

      const c = createMockContext({
        query: { lifecycle_state: 'incomplete' },
        db: mockDB,
      });

      await adminUsersListHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('lifecycle_state = ?'));
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          users: expect.arrayContaining([
            expect.objectContaining({
              lifecycle_state: 'incomplete',
            }),
          ]),
        })
      );
    });
  });

  describe('adminUserGetHandler', () => {
    it('should return user details with passkeys', async () => {
      const userId = 'user-123';
      // Core DB returns users_core data (no PII) and passkeys
      const mockDB = createMockDB({
        firstResult: {
          id: userId,
          tenant_id: 'default',
          email_verified: 1,
          phone_number_verified: 0,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: Date.now(),
          updated_at: Date.now(),
          last_login_at: null,
        },
        allResults: [
          {
            id: 'passkey-1',
            credential_id: 'cred-abc',
            device_name: 'Chrome on Mac',
            created_at: Date.now(),
            last_used_at: null,
          },
        ],
      });

      // PII DB returns users_pii data (email, name, etc.)
      const mockDBPII = createMockDB({
        firstResult: {
          id: userId,
          email: 'user@example.com',
          name: 'Test User',
        },
      });

      const c = createMockContext({
        params: { id: userId },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserGetHandler(c);

      // API returns { user, passkeys, customFields }
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            id: userId,
            email: 'user@example.com',
          }),
          passkeys: expect.any(Array),
        })
      );

      expect(
        (mockDB as any).prepare.mock.calls.some(([sql]: [string]) =>
          sql.includes('FROM user_custom_fields WHERE user_id = ? AND tenant_id = ?')
        )
      ).toBe(true);
    });

    it('should return 404 for non-existent user', async () => {
      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        params: { id: 'nonexistent-user' },
        db: mockDB,
      });

      await adminUserGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
          error_description: 'The requested resource was not found',
        }),
        404
      );
    });

    it('should include passkeys in user details', async () => {
      const userId = 'user-with-passkeys';
      const mockDB = createMockDB({
        firstResult: {
          id: userId,
          email: 'passkey-user@example.com',
          name: 'Passkey User',
          email_verified: 1,
          phone_number_verified: 0,
          created_at: Date.now(),
          updated_at: Date.now(),
          last_login_at: null,
        },
        allResults: [
          { id: 'pk-1', credential_id: 'cred-1', created_at: Date.now(), last_used_at: null },
          { id: 'pk-2', credential_id: 'cred-2', created_at: Date.now(), last_used_at: null },
        ],
      });

      const c = createMockContext({
        params: { id: userId },
        db: mockDB,
      });

      await adminUserGetHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('passkeys'));
    });

    it('should include lifecycle_state and missing_required_fields in user details', async () => {
      const userId = 'user-missing-required';
      const mockDB = createMockDB({
        firstResult: {
          id: userId,
          tenant_id: 'default',
          email_verified: 1,
          phone_number_verified: 0,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          lifecycle_state: 'incomplete',
          created_at: Date.now(),
          updated_at: Date.now(),
          last_login_at: null,
        },
        allResults: [],
      });
      let allCallCount = 0;
      (mockDB as any)._mockStatement.all.mockImplementation(() => {
        allCallCount++;
        if (allCallCount === 1) {
          return Promise.resolve({ results: [] });
        }
        if (allCallCount === 2) {
          return Promise.resolve({ results: [] });
        }
        if (allCallCount === 3) {
          return Promise.resolve({
            results: [createCustomClaimSchemaRow()],
          });
        }
        if (allCallCount === 4) {
          return Promise.resolve({ results: [] });
        }
        return Promise.resolve({ results: [] });
      });

      const mockDBPII = createMockDB({
        firstResult: {
          id: userId,
          email: 'user@example.com',
          name: 'Missing Required User',
          custom_attributes_json: '{}',
        },
        allResults: [],
      });

      const c = createMockContext({
        params: { id: userId },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            lifecycle_state: 'incomplete',
          }),
          missing_required_fields: [
            {
              field_key: 'department',
              label: 'Department',
              field_type: 'string',
            },
          ],
        })
      );
    });
  });

  describe('adminUserCreateHandler', () => {
    it('should require email field', async () => {
      const mockDB = createMockDB({});

      const c = createMockContext({
        method: 'POST',
        body: { name: 'User without email' },
        db: mockDB,
      });

      await adminUserCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Email is required',
        }),
        400
      );
    });

    it('should reject create when required custom field is missing', async () => {
      const mockDB = createMockDB({
        runResult: { success: true },
      });
      (mockDB as any)._mockStatement.all.mockResolvedValueOnce({
        results: [createCustomClaimSchemaRow()],
      });

      const mockDBPII = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          email: 'newuser@example.com',
          name: 'New User',
        },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Department is required',
          missing_required_fields: [
            {
              field_key: 'department',
              label: 'Department',
              field_type: 'string',
            },
          ],
        }),
        400
      );
    });

    it('should create new user with valid data', async () => {
      // PII/Non-PII DB Separation:
      // 1. Check email uniqueness in PII DB (returns null = no existing user)
      // 2. Insert into Core DB
      // 3. Insert into PII DB
      // 4. Update Core DB pii_status
      // 5. Fetch created user from both DBs

      const mockDB = createMockDB({
        runResult: { success: true },
      });
      (mockDB as any)._mockStatement.all.mockResolvedValueOnce({
        results: [createCustomClaimSchemaRow({ is_required: 0 })],
      });

      // Configure Core DB mock to return created user on final query
      let coreQueryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        coreQueryCount++;
        // After inserts and updates, return the created user_core data
        return Promise.resolve({
          id: 'new-user-id',
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: Date.now(),
          updated_at: Date.now(),
        });
      });

      // PII DB: first call checks email uniqueness, final call returns created PII
      const mockDBPII = createMockDB({
        runResult: { success: true },
      });
      let piiQueryCount = 0;
      (mockDBPII as any)._mockStatement.first.mockImplementation(() => {
        piiQueryCount++;
        if (piiQueryCount === 1) {
          // First query: check for existing user by email - return null (no duplicate)
          return Promise.resolve(null);
        }
        // Final query: return created user PII
        return Promise.resolve({
          id: 'new-user-id',
          email: 'newuser@example.com',
          name: 'New User',
        });
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          email: 'newuser@example.com',
          name: 'New User',
          department: 'Engineering',
        },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserCreateHandler(c);

      // Verify insert into Core DB
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users_core')
      );
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user_custom_fields SET')
      );
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_custom_fields')
      );
      // Verify insert into PII DB
      expect(mockDBPII.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users_pii')
      );
      // API returns { user }
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            email: 'newuser@example.com',
          }),
        }),
        201
      );
    });

    it('should prevent duplicate email (409 error)', async () => {
      // PII/Non-PII DB Separation:
      // Email uniqueness is checked in PII DB (not Core DB)
      const mockDB = createMockDB({});

      // PII DB returns existing user when checking for duplicate email
      const mockDBPII = createMockDB({
        firstResult: { id: 'existing-user', email: 'duplicate@example.com' },
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          email: 'duplicate@example.com',
          name: 'Duplicate User',
        },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserCreateHandler(c);

      // Security: Generic message to prevent email enumeration
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'conflict',
          error_description: 'Unable to create user with the provided information',
        }),
        409
      );
    });
  });

  describe('adminUserUpdateHandler', () => {
    it('should persist custom field updates', async () => {
      const userId = 'user-custom-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      let coreQueryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        coreQueryCount++;
        return Promise.resolve({
          id: userId,
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: Date.now(),
          updated_at: Date.now(),
          last_login_at: null,
        });
      });
      (mockDB as any)._mockStatement.all
        .mockResolvedValueOnce({
          results: [createCustomClaimSchemaRow({ is_required: 0 })],
        })
        .mockResolvedValueOnce({
          results: [],
        });

      const mockDBPII = createMockDB({
        firstResult: {
          id: userId,
          email: 'old@example.com',
          name: 'Updated Name',
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: userId },
        body: {
          department: 'Support',
        },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserUpdateHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user_custom_fields SET')
      );
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_custom_fields')
      );
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            id: userId,
          }),
        })
      );
    });

    it('should update user fields', async () => {
      // PII/Non-PII DB Separation:
      // Core fields (email_verified, phone_number_verified, user_type) → Core DB
      // PII fields (name, phone_number, picture, etc.) → PII DB

      const userId = 'user-to-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });
      (mockDB as any)._mockStatement.all
        .mockResolvedValueOnce({
          results: [createCustomClaimSchemaRow({ is_required: 0 })],
        })
        .mockResolvedValueOnce({
          results: [],
        });

      // Core DB: first call checks user exists, subsequent calls for updates/reads
      let coreQueryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        coreQueryCount++;
        // All calls return the user_core data
        return Promise.resolve({
          id: userId,
          tenant_id: 'default',
          email_verified: 1,
          phone_number_verified: 0,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: Date.now(),
          updated_at: Date.now(),
        });
      });

      // PII DB: returns updated PII data
      const mockDBPII = createMockDB({
        runResult: { success: true },
        firstResult: {
          id: userId,
          email: 'old@example.com',
          name: 'Updated Name',
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: userId },
        body: {
          name: 'Updated Name',
          email_verified: true,
        },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserUpdateHandler(c);

      // Verify Core DB update was called
      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE'));
      // API returns { user }
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            id: userId,
            name: 'Updated Name',
          }),
        })
      );
    });

    it('should return 404 for non-existent user', async () => {
      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'nonexistent-user' },
        body: { name: 'Update' },
        db: mockDB,
      });

      await adminUserUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
          error_description: 'The requested resource was not found',
        }),
        404
      );
    });

    it('should update timestamp on modification', async () => {
      // PII/Non-PII DB Separation:
      // Updated `name` is a PII field, stored in PII DB
      // Both Core DB and PII DB have updated_at timestamps

      const userId = 'user-update-ts';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      // Core DB: returns user_core data
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        return Promise.resolve({
          id: userId,
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: Date.now(),
          updated_at: Date.now(),
        });
      });

      // PII DB: returns updated PII data
      const mockDBPII = createMockDB({
        runResult: { success: true },
        firstResult: {
          id: userId,
          email: 'test@example.com',
          name: 'Updated',
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: userId },
        body: { name: 'Updated' },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserUpdateHandler(c);

      // Verify PII DB UPDATE query includes updated_at (name is a PII field)
      expect(mockDBPII.prepare).toHaveBeenCalledWith(expect.stringContaining('updated_at'));
    });
  });

  describe('adminUserDeleteHandler', () => {
    it('should delete user successfully', async () => {
      const userId = 'user-to-delete';
      const mockDB = createMockDB({
        firstResult: { id: userId, email: 'delete@example.com' },
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'DELETE',
        params: { id: userId },
        db: mockDB,
      });

      await adminUserDeleteHandler(c);

      // PII/Non-PII DB separation: User deletion is now soft delete
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users_core SET is_active = ?')
      );
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should return 404 for non-existent user', async () => {
      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        method: 'DELETE',
        params: { id: 'nonexistent-user' },
        db: mockDB,
      });

      await adminUserDeleteHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
          error_description: 'The requested resource was not found',
        }),
        404
      );
    });

    it('should cascade delete related data (passkeys, sessions)', async () => {
      const userId = 'user-with-related-data';
      const mockDB = createMockDB({
        firstResult: { id: userId, email: 'cascade@example.com' },
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'DELETE',
        params: { id: userId },
        db: mockDB,
      });

      await adminUserDeleteHandler(c);

      // PII/Non-PII DB separation: User deletion is soft delete + cascade deletes for related data
      // Check for soft delete on users_core
      const updateCalls = (mockDB.prepare as any).mock.calls.filter((call: any[]) =>
        call[0].includes('UPDATE users_core SET is_active = ?')
      );
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('adminUserAnonymizeHandler', () => {
    it('should anonymize using current schema tables and avoid legacy SQL', async () => {
      const userId = 'user-anon-1';
      let coreUpdateSql: string | null = null;
      let coreUpdateParams: unknown[] | null = null;
      const coreDb = createSqlAwareMockDB(async (sql, params, op) => {
        if (op === 'first') {
          if (sql.includes('SELECT * FROM users_core WHERE id = ?')) {
            return {
              id: userId,
              tenant_id: 'default',
              is_active: 1,
              pii_status: 'active',
              pii_partition: 'default',
              status: 'active',
              lifecycle_state: 'active',
              created_at: Date.now(),
              updated_at: Date.now(),
            };
          }
          if (sql.includes('SELECT id, reason FROM legal_holds')) {
            return null;
          }
          return undefined;
        }

        if (op === 'run' && sql.includes('UPDATE users_core SET')) {
          coreUpdateSql = sql;
          coreUpdateParams = [...params];
        }

        if (op === 'all' && sql.includes('SELECT * FROM sessions WHERE user_id = ?')) {
          return [
            {
              id: 'sess-1',
              user_id: userId,
              expires_at: Date.now() + 3600_000,
              created_at: Date.now(),
              tenant_id: 'default',
            },
          ];
        }

        return op === 'run' ? { success: true } : undefined;
      });

      const piiDb = createSqlAwareMockDB(async (sql, _params, op) => {
        if (op === 'first') {
          if (sql.includes('SELECT * FROM users_pii_tombstone WHERE id = ?')) {
            return null;
          }
          if (sql.includes('SELECT * FROM users_pii WHERE id = ?')) {
            return {
              id: userId,
              tenant_id: 'default',
              email: 'anon@example.com',
              email_blind_index: 'blind-index',
              created_at: Date.now(),
              updated_at: Date.now(),
            };
          }
          return undefined;
        }

        return op === 'run' ? { success: true } : undefined;
      });

      const c = createMockContext({
        method: 'POST',
        params: { id: userId },
        body: { reason_code: 'user_request', confirm: true },
        db: coreDb,
        dbPII: piiDb,
      });

      const res = await adminUserAnonymizeHandler(c);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        tombstone_id: string | null;
      };

      expect(body.success).toBe(true);
      expect(body.tombstone_id).toBe(userId);

      const coreSqls = (coreDb.prepare as any).mock.calls.map((call: [string]) => call[0]);
      const piiSqls = (piiDb.prepare as any).mock.calls.map((call: [string]) => call[0]);

      expect(piiSqls).toContainEqual(expect.stringContaining('INSERT INTO users_pii_tombstone'));
      expect(piiSqls).toContainEqual(expect.stringContaining('DELETE FROM users_pii WHERE id = ?'));
      expect(coreSqls).toContainEqual(
        expect.stringContaining('DELETE FROM subject_org_membership')
      );
      expect(coreSqls).toContainEqual(
        expect.stringContaining('DELETE FROM passkeys WHERE user_id = ?')
      );
      expect(coreSqls).toContainEqual(
        expect.stringContaining('DELETE FROM sessions WHERE user_id = ?')
      );
      expect(coreSqls).toContainEqual(
        expect.stringContaining('DELETE FROM session_clients WHERE session_id = ?')
      );
      expect(coreSqls).toContainEqual(
        expect.stringContaining('DELETE FROM user_roles WHERE user_id = ?')
      );
      expect(coreUpdateSql).toContain('status = ?');
      expect(coreUpdateSql).toContain('lifecycle_state = ?');
      expect(coreUpdateParams).toEqual(
        expect.arrayContaining([false, 'deleted', 'locked', 'deprovisioned', userId])
      );
      expect(coreSqls).not.toContainEqual(expect.stringContaining('UPDATE sessions SET revoked'));
      expect(coreSqls).not.toContainEqual(expect.stringContaining('organization_members'));
      expect(coreSqls).not.toContainEqual(expect.stringContaining('passkey_credentials'));
      expect(piiSqls).not.toContainEqual(
        expect.stringContaining('DELETE FROM users_pii WHERE user_id = ?')
      );
    });
  });

  describe('adminUserSendEmailHandler', () => {
    it('should load email from users_pii by id and tenant_id before enqueuing email', async () => {
      const userId = 'user-mail-1';
      const coreDb = createSqlAwareMockDB(async (sql, _params, op) => {
        if (
          op === 'first' &&
          sql.includes('SELECT * FROM users_core WHERE id = ? AND is_active = 1')
        ) {
          return {
            id: userId,
            tenant_id: 'default',
            is_active: 1,
            pii_status: 'active',
            pii_partition: 'default',
            status: 'active',
            lifecycle_state: 'active',
            created_at: Date.now(),
            updated_at: Date.now(),
          };
        }

        return op === 'run' ? { success: true } : undefined;
      });

      const piiDb = createSqlAwareMockDB(async (sql, params, op) => {
        if (
          op === 'first' &&
          sql.includes('SELECT email FROM users_pii WHERE id = ? AND tenant_id = ?')
        ) {
          expect(params).toEqual([userId, 'default']);
          return { email: 'mail@example.com' };
        }

        return op === 'run' ? { success: true } : undefined;
      });

      const c = createMockContext({
        method: 'POST',
        params: { id: userId },
        body: {
          template: 'welcome',
          subject: 'hello',
          variables: { locale: 'ja' },
        },
        db: coreDb,
        dbPII: piiDb,
      });

      const res = await adminUserSendEmailHandler(c);
      expect(res.status).toBe(200);

      const piiSqls = (piiDb.prepare as any).mock.calls.map((call: [string]) => call[0]);
      const coreSqls = (coreDb.prepare as any).mock.calls.map((call: [string]) => call[0]);

      expect(piiSqls).toContainEqual(
        expect.stringContaining('SELECT email FROM users_pii WHERE id = ? AND tenant_id = ?')
      );
      expect(piiSqls).not.toContainEqual(expect.stringContaining('WHERE user_id = ?'));
      expect(coreSqls).toContainEqual(expect.stringContaining('INSERT INTO email_queue'));
    });
  });

  describe('adminClientsListHandler', () => {
    it('should return paginated clients list', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 25 },
        allResults: [
          {
            client_id: 'client-1',
            client_name: 'Client One',
            redirect_uris: '["https://example.com/callback"]',
            grant_types: '["authorization_code"]',
            response_types: '["code"]',
            created_at: Date.now(),
            updated_at: Date.now(),
          },
          {
            client_id: 'client-2',
            client_name: 'Client Two',
            redirect_uris: '["https://another.com/callback"]',
            grant_types: '["authorization_code","refresh_token"]',
            response_types: '["code"]',
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ],
      });

      const c = createMockContext({
        query: { page: '1', limit: '10' },
        db: mockDB,
      });

      await adminClientsListHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          clients: expect.any(Array),
          pagination: expect.objectContaining({
            page: 1,
            limit: 10,
            total: 25,
          }),
        })
      );
    });

    it('should support search filtering by client_id or client_name', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 1 },
        allResults: [
          {
            client_id: 'my-app-client',
            client_name: 'My App',
            redirect_uris: '["https://myapp.com/callback"]',
            grant_types: '["authorization_code"]',
            response_types: '["code"]',
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ],
      });

      const c = createMockContext({
        query: { search: 'my-app' },
        db: mockDB,
      });

      await adminClientsListHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('LIKE'));
    });

    it('should parse JSON fields correctly', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 1 },
        allResults: [
          {
            client_id: 'json-client',
            client_name: 'JSON Test Client',
            redirect_uris: '["https://a.com/cb","https://b.com/cb"]',
            grant_types: '["authorization_code","refresh_token"]',
            response_types: '["code"]',
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ],
      });

      const c = createMockContext({ db: mockDB });

      await adminClientsListHandler(c);

      // adminClientsListHandler does not parse JSON fields for list view (optimization)
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          clients: expect.any(Array),
          pagination: expect.any(Object),
        })
      );
    });
  });

  describe('adminClientGetHandler', () => {
    it('should return client details', async () => {
      const clientId = 'test-client';
      const mockDB = createMockDB({
        firstResult: {
          client_id: clientId,
          client_name: 'Test Client',
          client_secret: 'secret-hash',
          redirect_uris: '["https://example.com/callback"]',
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
          scope: 'openid profile email',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      });

      const c = createMockContext({
        params: { id: clientId },
        db: mockDB,
      });

      await adminClientGetHandler(c);

      // API returns { client: {...} }
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            client_id: clientId,
            client_name: 'Test Client',
            scope: 'openid profile email',
          }),
        })
      );
    });

    it('should return 404 for non-existent client', async () => {
      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        params: { id: 'nonexistent-client' },
        db: mockDB,
      });

      await adminClientGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
          error_description: 'The requested resource was not found',
        }),
        404
      );
    });

    it('should normalize JSON fields in response', async () => {
      const clientId = 'json-normalize-client';
      const mockDB = createMockDB({
        firstResult: {
          client_id: clientId,
          client_name: 'Normalize Client',
          redirect_uris: '["https://a.com","https://b.com"]',
          grant_types: '["authorization_code","refresh_token"]',
          response_types: '["code"]',
          jwks: '{"keys":[]}',
          contacts: '["admin@example.com"]',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      });

      const c = createMockContext({
        params: { id: clientId },
        db: mockDB,
      });

      await adminClientGetHandler(c);

      // API returns { client: {...} } with parsed JSON fields
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            redirect_uris: expect.any(Array),
            grant_types: expect.any(Array),
          }),
        })
      );
    });
  });

  describe('adminClientCreateHandler', () => {
    it('should require redirect_uris', async () => {
      const mockDB = createMockDB({});

      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Client without URIs',
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('redirect_uris'),
        }),
        400
      );
    });

    it('should require client_name', async () => {
      const mockDB = createMockDB({});

      const c = createMockContext({
        method: 'POST',
        body: {
          redirect_uris: ['https://example.com/callback'],
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('client_name'),
        }),
        400
      );
    });

    it('should create new client with valid data', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'New Test Client',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT'));
      // API returns { client: {...} }
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            client_id: expect.any(String),
            client_secret: expect.any(String),
            client_name: 'New Test Client',
          }),
        }),
        201
      );
    });

    it('should create a token-exchange capable service client', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Service Client',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_exchange_allowed: true,
          delegation_mode: 'delegation',
          client_credentials_allowed: true,
          allowed_subject_token_clients: ['svc-client-a'],
          allowed_token_exchange_resources: ['svc://op-userinfo/customer-profile'],
          allowed_scopes: ['openid', 'profile'],
          default_scope: 'openid profile',
          default_audience: 'svc://op-userinfo/customer-profile',
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            client_name: 'Service Client',
            token_exchange_allowed: true,
            delegation_mode: 'delegation',
            client_credentials_allowed: true,
            allowed_subject_token_clients: ['svc-client-a'],
            allowed_token_exchange_resources: ['svc://op-userinfo/customer-profile'],
            allowed_scopes: ['openid', 'profile'],
            default_scope: 'openid profile',
            default_audience: 'svc://op-userinfo/customer-profile',
          }),
        }),
        201
      );
    });

    it('should create client policy metadata for Phase 1 flows', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Native Wallet',
          redirect_uris: ['https://example.com/callback'],
          application_type: 'native',
          trust_group: 'wallet-suite',
          browser_public_client_mode: 'cookie_fallback',
          browser_refresh_token_policy: 'dpop_bound',
          native_sso_enabled: true,
          native_channel_allowed: true,
          allowed_channels: ['native'],
          device_secret_revoke_enabled: true,
          device_secret_revoke_trust_groups: ['wallet-suite'],
          device_secret_introspection_enabled: true,
          device_secret_introspection_trust_groups: ['wallet-suite'],
          default_resource: 'svc://wallet-api',
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            application_type: 'native',
            trust_group: 'wallet-suite',
            browser_public_client_mode: 'cookie_fallback',
            browser_refresh_token_policy: 'dpop_bound',
            native_sso_enabled: true,
            native_channel_allowed: true,
            allowed_channels: ['native'],
            device_secret_revoke_enabled: true,
            device_secret_revoke_trust_groups: ['wallet-suite'],
            device_secret_introspection_enabled: true,
            device_secret_introspection_trust_groups: ['wallet-suite'],
            default_resource: 'svc://wallet-api',
          }),
        }),
        201
      );
    });

    it('should generate client_id and client_secret', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Auto ID Client',
          redirect_uris: ['https://example.com/callback'],
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            client_id: expect.stringMatching(/^[a-f0-9-]{36}$/), // UUID format
            client_secret: expect.any(String),
          }),
        }),
        201
      );
    });

    it('should reject invalid redirect_uris', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Broken Redirect Client',
          redirect_uris: ['not-a-valid-uri'],
        },
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Invalid redirect_uri: not-a-valid-uri',
        }),
        400
      );
    });

    it('should reject invalid allowed_redirect_origins', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Origin Validation Client',
          redirect_uris: ['https://example.com/callback'],
          allowed_redirect_origins: ['https://example.com/path'],
        },
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('Invalid allowed_redirect_origins'),
        }),
        400
      );
    });

    it('should reject invalid web_origin_registry before creating the client', async () => {
      const mockDB = createMockDB({});
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Origin Registry Client',
          redirect_uris: ['https://example.com/callback'],
          web_origin_registry: {
            origins: [{ origin: 'https://example.com/path' }],
          },
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('Invalid web_origin_registry origins'),
        }),
        400
      );
      expect(mockDB.prepare).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO oauth_clients')
      );
    });

    it('should reject legacy app_suite in admin client create', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Legacy Client',
          redirect_uris: ['https://example.com/callback'],
          app_suite: 'wallet-suite',
        },
      });

      const res = await adminClientCreateHandler(c);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toMatchObject({
        error: 'legacy_app_suite_not_supported',
        error_uri: 'https://docs.authrim.com/errors/error-codes#legacy-app-suite-not-supported',
        error_details: expect.objectContaining({
          code: 'legacy_app_suite_not_supported',
          severity: 'fatal',
        }),
      });
    });

    it('should reject multiple trust_group assignments in admin client create', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Invalid Trust Group Client',
          redirect_uris: ['https://example.com/callback'],
          trust_group: ['wallet-a', 'wallet-b'],
        },
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'trust_group must be a string or null',
        }),
        400
      );
    });
  });

  describe('adminClientUpdateHandler', () => {
    it('should reject legacy app_suite in admin client update', async () => {
      const clientId = 'legacy-client-update';
      const mockDB = createMockDB({
        firstResult: {
          client_id: clientId,
          client_name: 'Existing Client',
          redirect_uris: '["https://example.com/callback"]',
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          app_suite: 'wallet-suite',
        },
        db: mockDB,
      });

      const res = await adminClientUpdateHandler(c);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toMatchObject({
        error: 'legacy_app_suite_not_supported',
        error_uri: 'https://docs.authrim.com/errors/error-codes#legacy-app-suite-not-supported',
        error_details: expect.objectContaining({
          code: 'legacy_app_suite_not_supported',
          severity: 'fatal',
        }),
      });
    });

    it('should update client fields', async () => {
      const clientId = 'client-to-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      // First call checks if client exists, second call gets updated client
      let queryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) {
          return Promise.resolve({
            client_id: clientId,
            client_name: 'Old Name',
            redirect_uris: '["https://old.com/cb"]',
            grant_types: '["authorization_code"]',
            response_types: '["code"]',
          });
        }
        return Promise.resolve({
          client_id: clientId,
          client_name: 'Updated Client Name',
          redirect_uris: '["https://new.com/callback"]',
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
        });
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          client_name: 'Updated Client Name',
          redirect_uris: ['https://new.com/callback'],
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE'));
      // API returns { success, client }
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          client: expect.objectContaining({
            client_id: clientId,
            client_name: 'Updated Client Name',
          }),
        })
      );
    });

    it('should update token exchange and downstream grant fields', async () => {
      const clientId = 'client-downstream-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      let queryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) {
          return Promise.resolve({
            client_id: clientId,
            client_name: 'Existing Client',
            redirect_uris: '["https://example.com/callback"]',
            grant_types: '["authorization_code"]',
            response_types: '["code"]',
            token_exchange_allowed: 0,
            allowed_subject_token_clients: null,
            allowed_token_exchange_resources: null,
            delegation_mode: 'none',
            client_credentials_allowed: 0,
            allowed_scopes: '["openid"]',
            default_scope: 'openid',
            default_audience: null,
          });
        }
        return Promise.resolve({
          client_id: clientId,
          client_name: 'Existing Client',
          redirect_uris: '["https://example.com/callback"]',
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
          token_exchange_allowed: 1,
          allowed_subject_token_clients: '["svc-client-a"]',
          allowed_token_exchange_resources: '["svc://op-userinfo/customer-profile"]',
          delegation_mode: 'delegation',
          client_credentials_allowed: 1,
          allowed_scopes: '["openid","profile"]',
          default_scope: 'openid profile',
          default_audience: 'svc://op-userinfo/customer-profile',
        });
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          token_exchange_allowed: true,
          delegation_mode: 'delegation',
          client_credentials_allowed: true,
          allowed_subject_token_clients: ['svc-client-a'],
          allowed_token_exchange_resources: ['svc://op-userinfo/customer-profile'],
          allowed_scopes: ['openid', 'profile'],
          default_scope: 'openid profile',
          default_audience: 'svc://op-userinfo/customer-profile',
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          client: expect.objectContaining({
            client_id: clientId,
            token_exchange_allowed: true,
            delegation_mode: 'delegation',
            client_credentials_allowed: true,
            allowed_subject_token_clients: ['svc-client-a'],
            allowed_token_exchange_resources: ['svc://op-userinfo/customer-profile'],
            allowed_scopes: ['openid', 'profile'],
            default_scope: 'openid profile',
            default_audience: 'svc://op-userinfo/customer-profile',
          }),
        })
      );
    });

    it('should update Phase 1 client policy metadata', async () => {
      const clientId = 'client-policy-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      let queryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) {
          return Promise.resolve({
            client_id: clientId,
            client_name: 'Existing Client',
            redirect_uris: '["https://example.com/callback"]',
            grant_types: '["authorization_code"]',
            response_types: '["code"]',
          });
        }
        return Promise.resolve({
          client_id: clientId,
          client_name: 'Existing Client',
          redirect_uris: '["https://example.com/callback"]',
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
          application_type: 'native',
          trust_group: 'wallet-suite',
          trust_group_id: 'wallet-suite',
          browser_public_client_mode: 'strict',
          browser_refresh_token_policy: 'disabled',
          native_sso_enabled: 0,
          native_channel_allowed: 1,
          allowed_channels: '["browser","native"]',
          device_secret_revoke_enabled: 1,
          device_secret_revoke_trust_groups: '["wallet-suite"]',
          device_secret_introspection_enabled: 0,
          device_secret_introspection_trust_groups: '["wallet-suite"]',
          default_resource: 'svc://wallet-api',
        });
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          application_type: 'native',
          trust_group: 'wallet-suite',
          browser_public_client_mode: 'strict',
          browser_refresh_token_policy: 'disabled',
          native_sso_enabled: false,
          native_channel_allowed: true,
          allowed_channels: ['browser', 'native'],
          device_secret_revoke_enabled: true,
          device_secret_revoke_trust_groups: ['wallet-suite'],
          device_secret_introspection_enabled: false,
          device_secret_introspection_trust_groups: ['wallet-suite'],
          default_resource: 'svc://wallet-api',
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          client: expect.objectContaining({
            application_type: 'native',
            trust_group: 'wallet-suite',
            browser_public_client_mode: 'strict',
            browser_refresh_token_policy: 'disabled',
            native_sso_enabled: false,
            native_channel_allowed: true,
            allowed_channels: ['browser', 'native'],
            device_secret_revoke_enabled: true,
            device_secret_revoke_trust_groups: ['wallet-suite'],
            device_secret_introspection_enabled: false,
            device_secret_introspection_trust_groups: ['wallet-suite'],
            default_resource: 'svc://wallet-api',
          }),
        })
      );
    });

    it('should return 404 for non-existent client', async () => {
      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'nonexistent-client' },
        body: { client_name: 'Update' },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
          error_description: 'The requested resource was not found',
        }),
        404
      );
    });

    it('should reject malformed character-array grant types', async () => {
      const clientId = 'client-malformed-grants';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      (mockDB as any)._mockStatement.first.mockResolvedValue({
        client_id: clientId,
        client_name: 'Existing Client',
        redirect_uris: '["https://example.com/callback"]',
        grant_types: '["authorization_code"]',
        response_types: '["code"]',
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          grant_types: ['a', 'u', 't', 'h'],
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('grant_types appears malformed'),
        }),
        400
      );
    });

    it('should reject invalid redirect_uris during update', async () => {
      const clientId = 'client-invalid-redirect-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      (mockDB as any)._mockStatement.first.mockResolvedValue({
        client_id: clientId,
        client_name: 'Existing Client',
        redirect_uris: '["https://example.com/callback"]',
        grant_types: '["authorization_code"]',
        response_types: '["code"]',
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          redirect_uris: ['still-not-a-uri'],
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'redirect_uris must contain valid URI strings',
        }),
        400
      );
    });

    it('should return a no-op response when no updates are provided', async () => {
      const clientId = 'client-no-op';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      (mockDB as any)._mockStatement.first.mockResolvedValue({
        client_id: clientId,
        client_name: 'Existing Client',
        redirect_uris: '["https://example.com/callback"]',
        grant_types: '["authorization_code"]',
        response_types: '["code"]',
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {},
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith({
        success: true,
        message: 'No changes to update',
      });
    });
  });

  describe('adminClientDeleteHandler', () => {
    it('should delete client successfully', async () => {
      const clientId = 'client-to-delete';
      const mockDB = createMockDB({
        firstResult: { client_id: clientId, client_name: 'Delete Me' },
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'DELETE',
        params: { id: clientId },
        db: mockDB,
      });

      await adminClientDeleteHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE'));
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should return 404 for non-existent client', async () => {
      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        method: 'DELETE',
        params: { id: 'nonexistent-client' },
        db: mockDB,
      });

      await adminClientDeleteHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
          error_description: 'The requested resource was not found',
        }),
        404
      );
    });
  });

  describe('adminClientRegenerateSecretHandler', () => {
    it('should reject grace periods outside the supported range', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'client-123' },
        body: { grace_period_hours: 0 },
      });

      const response = await adminClientRegenerateSecretHandler(c);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual(
        expect.objectContaining({
          error: 'invalid_request',
        })
      );
    });

    it('should return 404 when the client belongs to another tenant', async () => {
      const mockClientCache = createMockKVNamespace({
        'tenant:default:client:client-foreign': JSON.stringify({
          client_id: 'client-foreign',
          tenant_id: 'tenant-foreign',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
        }),
      });

      const c = createMockContext({
        method: 'POST',
        params: { id: 'client-foreign' },
        envOverrides: {
          CLIENTS_CACHE: mockClientCache as unknown as Env['CLIENTS_CACHE'],
        },
      });

      const response = await adminClientRegenerateSecretHandler(c);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body).toEqual(
        expect.objectContaining({
          error: 'invalid_request',
        })
      );
    });

    it('should rotate the secret, revoke tokens, and disable caching', async () => {
      const mockDB = createMockDB({
        runResult: {
          success: true,
          meta: {
            changes: 3,
            duration: 1,
          },
        } as unknown as { success: boolean },
      });
      const mockClientCache = createMockKVNamespace({
        'tenant:default:client:client-rotate': JSON.stringify({
          client_id: 'client-rotate',
          tenant_id: 'default',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
        }),
      });

      const c = createMockContext({
        method: 'POST',
        params: { id: 'client-rotate' },
        body: {
          revoke_existing_tokens: true,
          grace_period_hours: 24,
        },
        db: mockDB,
        envOverrides: {
          CLIENTS_CACHE: mockClientCache as unknown as Env['CLIENTS_CACHE'],
        },
      });

      const response = await adminClientRegenerateSecretHandler(c);
      const payload = (await response.json()) as { revoked_tokens: number };

      expect(response.status).toBe(200);
      expect(c.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
      expect(mockClientCache.delete).toHaveBeenCalledWith(expect.stringContaining('client-rotate'));
      expect(payload).toEqual(
        expect.objectContaining({
          client_id: 'client-rotate',
          client_secret: expect.stringMatching(/^[a-f0-9]{64}$/),
          revoked_tokens: 3,
        })
      );
    });

    it('should tolerate invalid JSON bodies and use default options', async () => {
      const mockDB = createMockDB({
        runResult: {
          success: true,
          meta: {
            changes: 0,
            duration: 1,
          },
        } as unknown as { success: boolean },
      });
      const mockClientCache = createMockKVNamespace({
        'tenant:default:client:client-defaults': JSON.stringify({
          client_id: 'client-defaults',
          tenant_id: 'default',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
        }),
      });

      const c = createMockContext({
        method: 'POST',
        params: { id: 'client-defaults' },
        db: mockDB,
        jsonError: new SyntaxError('Unexpected token'),
        envOverrides: {
          CLIENTS_CACHE: mockClientCache as unknown as Env['CLIENTS_CACHE'],
        },
      });

      const response = await adminClientRegenerateSecretHandler(c);
      const payload = (await response.json()) as { revoked_tokens: number };

      expect(response.status).toBe(200);
      expect(payload.revoked_tokens).toBe(0);
      expect(c.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    });
  });
});
