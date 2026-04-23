/**
 * Custom Claim Schemas Admin API Tests
 *
 * Tests for custom claim schema management endpoints:
 * - GET /api/admin/custom-claims - List schemas
 * - POST /api/admin/custom-claims - Create schema
 * - GET /api/admin/custom-claims/reserved-names - Reserved names
 * - GET /api/admin/custom-claims/stats - Statistics
 * - GET /api/admin/custom-claims/:id - Get schema
 * - PUT /api/admin/custom-claims/:id - Update schema
 * - DELETE /api/admin/custom-claims/:id - Delete schema (2-phase)
 * - PATCH /api/admin/custom-claims/:id/rename - Rename field_key (2-phase)
 * - POST /api/admin/custom-claims/:id/retry - Retry failed operation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

// Mock ar-lib-core
const mockGenerateId = vi.fn().mockReturnValue('test-id-123');
const mockSchemaHistoryRecordChange = vi.fn().mockResolvedValue(undefined);
const mockGetRequiredCustomClaimViolationStatuses = vi.fn();
const mockCountUsersWithNonPiiCustomClaimData = vi.fn(async (_db: unknown, _tenantId: string) => {
  const rows = await mockDbQuery('COUNT_NON_PII_USERS');
  return rows[0]?.count || 0;
});
const mockCountUsersWithPiiCustomClaimData = vi.fn(async (_dbPii: unknown, _tenantId: string) => {
  const rows = await mockPiiQuery('COUNT_PII_USERS');
  return rows[0]?.count || 0;
});
const mockListNonPiiFieldUsage = vi.fn(async (_db: unknown, _tenantId: string) => {
  const rows = await mockDbQuery('LIST_NON_PII_FIELD_USAGE');
  return rows.map((row: { field_name: string; count: number }) => ({
    fieldName: row.field_name,
    count: row.count,
  }));
});
const mockCountUsersWithNonPiiFieldData = vi.fn(async (_db: unknown, _tenantId: string, fieldKey: string) => {
  const rows = await mockDbQuery('COUNT_NON_PII_FIELD_USERS', fieldKey);
  return rows[0]?.count || 0;
});
const mockDeleteStoredCustomClaimData = vi.fn(
  async ({
    fieldKey,
    isPii,
  }: {
    fieldKey: string;
    isPii: boolean;
  }) => {
    if (!isPii) {
      const result = await mockDbExecute(
        'DELETE FROM user_custom_fields WHERE tenant_id = ? AND field_name = ?',
        ['test-tenant', fieldKey]
      );
      return {
        affectedUsers: result?.rowsAffected || 0,
        processedUsers: result?.rowsAffected || 0,
        failedUsers: 0,
      };
    }

    const batch = await mockPiiQuery('SCAN_PII_DELETE', fieldKey);
    let affectedUsers = 0;
    let failedUsers = 0;

    for (const row of batch) {
      try {
        const attrs = JSON.parse(row.custom_attributes_json);
        if (fieldKey in attrs) {
          delete attrs[fieldKey];
          await mockPiiExecute(
            'UPDATE users_pii SET custom_attributes_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
            [JSON.stringify(attrs), 0, row.id, 'test-tenant']
          );
          affectedUsers++;
        }
      } catch {
        failedUsers++;
      }
    }

    return {
      affectedUsers,
      processedUsers: batch.length,
      failedUsers,
    };
  }
);
const mockRenameStoredCustomClaimData = vi.fn(
  async ({
    oldKey,
    newKey,
    isPii,
  }: {
    oldKey: string;
    newKey: string;
    isPii: boolean;
  }) => {
    if (!isPii) {
      const result = await mockDbExecute(
        'UPDATE user_custom_fields SET field_name = ? WHERE tenant_id = ? AND field_name = ?',
        [newKey, 'test-tenant', oldKey]
      );
      return {
        affectedUsers: result?.rowsAffected || 0,
        processedUsers: result?.rowsAffected || 0,
        failedUsers: 0,
      };
    }

    const batch = await mockPiiQuery('SCAN_PII_RENAME', oldKey, newKey);
    let affectedUsers = 0;
    let failedUsers = 0;

    for (const row of batch) {
      try {
        const attrs = JSON.parse(row.custom_attributes_json);
        if (oldKey in attrs && !(newKey in attrs)) {
          attrs[newKey] = attrs[oldKey];
          delete attrs[oldKey];
          await mockPiiExecute(
            'UPDATE users_pii SET custom_attributes_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
            [JSON.stringify(attrs), 0, row.id, 'test-tenant']
          );
          affectedUsers++;
        }
      } catch {
        failedUsers++;
      }
    }

    return {
      affectedUsers,
      processedUsers: batch.length,
      failedUsers,
    };
  }
);

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const selectMockAdapter = (db: unknown) => {
    const query = db === mockPiiDb ? mockPiiQuery : mockDbQuery;
    const execute = db === mockPiiDb ? mockPiiExecute : mockDbExecute;

    const queryOne = vi.fn(async (sql: string, params?: unknown[]) => {
      const rows = await query(sql, params);
      return Array.isArray(rows) ? (rows[0] ?? null) : null;
    });

    if (db === mockPiiDb) {
      return {
        query,
        queryOne,
        execute,
        transaction: vi.fn(),
        batch: vi.fn(),
        isHealthy: vi.fn().mockResolvedValue(true),
        getType: vi.fn().mockReturnValue('mock'),
        close: vi.fn(),
      };
    }

    return {
      query,
      queryOne,
      execute,
      transaction: vi.fn(),
      batch: vi.fn(),
      isHealthy: vi.fn().mockResolvedValue(true),
      getType: vi.fn().mockReturnValue('mock'),
      close: vi.fn(),
    };
  };

  return {
    ...actual,
    generateId: (...args: unknown[]) => mockGenerateId(...args),
    createAuditLogFromContext: vi.fn(),
    getTenantIdFromContext: vi.fn().mockReturnValue('test-tenant'),
    ensureDatabaseAdapter: vi.fn().mockImplementation((db: unknown) => selectMockAdapter(db)),
    countUsersWithNonPiiCustomClaimData: (db: unknown, tenantId: string) =>
      mockCountUsersWithNonPiiCustomClaimData(db, tenantId),
    countUsersWithPiiCustomClaimData: (dbPii: unknown, tenantId: string) =>
      mockCountUsersWithPiiCustomClaimData(dbPii, tenantId),
    listNonPiiFieldUsage: (db: unknown, tenantId: string) =>
      mockListNonPiiFieldUsage(db, tenantId),
    countUsersWithNonPiiFieldData: (db: unknown, tenantId: string, fieldKey: string) =>
      mockCountUsersWithNonPiiFieldData(db, tenantId, fieldKey),
    deleteStoredCustomClaimData: (params: {
      db: unknown;
      dbPii?: unknown;
      tenantId: string;
      fieldKey: string;
      isPii: boolean;
    }) => mockDeleteStoredCustomClaimData(params),
    renameStoredCustomClaimData: (params: {
      db: unknown;
      dbPii?: unknown;
      tenantId: string;
      oldKey: string;
      newKey: string;
      isPii: boolean;
    }) => mockRenameStoredCustomClaimData(params),
    D1Adapter: vi.fn().mockImplementation(function (opts: { db: unknown }) {
      return selectMockAdapter(opts.db);
    }),
    CustomClaimSchemaHistoryManager: vi
      .fn()
      .mockImplementation(function MockCustomClaimSchemaHistoryManager() {
        return {
          recordChange: mockSchemaHistoryRecordChange,
        };
      }),
    getRequiredCustomClaimViolationStatuses: (...args: unknown[]) =>
      mockGetRequiredCustomClaimViolationStatuses(...args),
  };
});

import {
  adminCustomClaimsListHandler,
  adminCustomClaimCreateHandler,
  adminCustomClaimsReservedNamesHandler,
  adminCustomClaimsStatsHandler,
  adminCustomClaimRequiredViolationsDetectHandler,
  adminCustomClaimGetHandler,
  adminCustomClaimUpdateHandler,
  adminCustomClaimDeleteHandler,
  adminCustomClaimRenameHandler,
  adminCustomClaimRetryHandler,
} from '../admin-custom-claims';

// =============================================================================
// Mocks
// =============================================================================

const mockDbQuery = vi.fn();
const mockDbExecute = vi.fn();
const mockPiiQuery = vi.fn();
const mockPiiExecute = vi.fn();
const mockPiiDb = Symbol('PII_DB');

function createMockKV(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: vi.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn().mockResolvedValue({ keys: [] }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

function createMockContext(options: {
  method?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  kv?: KVNamespace;
}) {
  const mockKV = options.kv ?? createMockKV();

  const contextStore = new Map<string, unknown>([
    ['tenantId', 'test-tenant'],
    ['adminAuth', { userId: 'admin-1', authMethod: 'password' }],
  ]);

  const c = {
    req: {
      method: options.method || 'GET',
      param: vi.fn().mockImplementation((name: string) => options.params?.[name]),
      query: vi.fn().mockImplementation((name: string) => options.query?.[name]),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
      header: vi.fn().mockReturnValue(null),
    },
    env: {
      DB: {} as D1Database,
      DB_PII: mockPiiDb,
      SETTINGS: mockKV,
      AUTHRIM_CONFIG: mockKV,
    } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  } as any;

  return c;
}

async function getResponseData(response: Response | void): Promise<{ body: any; status: number }> {
  if (!response) return { body: null, status: 200 };
  const text = await response.text();
  try {
    return { body: JSON.parse(text), status: response.status };
  } catch {
    return { body: text, status: response.status };
  }
}

function createSchemaRow(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id: 'schema-1',
    tenant_id: 'test-tenant',
    field_key: 'employee_id',
    display_label: 'Employee ID',
    field_type: 'string',
    is_pii: 0,
    is_required: 0,
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
    created_by: 'admin-1',
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Custom Claims Admin API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbExecute.mockReset();
    mockPiiQuery.mockReset();
    mockPiiExecute.mockReset();
    mockGenerateId.mockReturnValue('test-id-123');
    mockSchemaHistoryRecordChange.mockReset();
    mockSchemaHistoryRecordChange.mockResolvedValue(undefined);
    mockGetRequiredCustomClaimViolationStatuses.mockReset();
  });

  // ===========================================================================
  // LIST
  // ===========================================================================

  describe('GET /api/admin/custom-claims (List)', () => {
    it('should return paginated list of schemas', async () => {
      const schemas = [createSchemaRow(), createSchemaRow({ id: 'schema-2', field_key: 'dept' })];
      mockDbQuery
        .mockResolvedValueOnce([{ count: 2 }]) // COUNT query
        .mockResolvedValueOnce(schemas); // SELECT query

      const c = createMockContext({});
      const res = await adminCustomClaimsListHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.schemas).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
      expect(body.pagination.page).toBe(1);
    });

    it('should apply search filter', async () => {
      mockDbQuery.mockResolvedValueOnce([{ count: 0 }]).mockResolvedValueOnce([]);

      const c = createMockContext({ query: { search: 'emp' } });
      await adminCustomClaimsListHandler(c);

      // Verify search LIKE pattern was passed
      const countCall = mockDbQuery.mock.calls[0];
      expect(countCall[0]).toContain('LIKE');
      expect(countCall[1]).toContain('%emp%');
    });

    it('should apply field_type filter', async () => {
      mockDbQuery.mockResolvedValueOnce([{ count: 0 }]).mockResolvedValueOnce([]);

      const c = createMockContext({ query: { field_type: 'number' } });
      await adminCustomClaimsListHandler(c);

      const countCall = mockDbQuery.mock.calls[0];
      expect(countCall[0]).toContain('field_type = ?');
      expect(countCall[1]).toContain('number');
    });

    it('should limit page size to 100', async () => {
      mockDbQuery.mockResolvedValueOnce([{ count: 0 }]).mockResolvedValueOnce([]);

      const c = createMockContext({ query: { limit: '500' } });
      const res = await adminCustomClaimsListHandler(c);
      const { body } = await getResponseData(res);

      expect(body.pagination.limit).toBe(100);
    });
  });

  // ===========================================================================
  // CREATE
  // ===========================================================================

  describe('POST /api/admin/custom-claims (Create)', () => {
    it('should create a schema with valid input', async () => {
      mockDbQuery
        .mockResolvedValueOnce([]) // duplicate check
        .mockResolvedValueOnce([createSchemaRow({ id: 'test-id-123' })]); // fetch created
      mockDbExecute.mockResolvedValue({ rowsAffected: 1 });

      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'employee_id',
          display_label: 'Employee ID',
          field_type: 'string',
          is_pii: false,
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(201);
      expect(body.schema).toBeDefined();
    });

    it('should reject missing field_key', async () => {
      const c = createMockContext({
        method: 'POST',
        body: { display_label: 'Test' },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(400);
    });

    it('should reject invalid field_key pattern', async () => {
      const c = createMockContext({
        method: 'POST',
        body: { field_key: 'Invalid-Key', display_label: 'Test' },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should reject reserved OIDC claim names', async () => {
      const c = createMockContext({
        method: 'POST',
        body: { field_key: 'sub', display_label: 'Subject' },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should reject display_label longer than 255 chars', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'test_field',
          display_label: 'A'.repeat(256),
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(400);
    });

    it('should reject description longer than 2000 chars', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'test_field',
          display_label: 'Test',
          description: 'X'.repeat(2001),
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(400);
    });

    it('should reject invalid field_type', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'test_field',
          display_label: 'Test',
          field_type: 'invalid',
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(400);
    });

    it('should reject duplicate active field_key', async () => {
      mockDbQuery.mockResolvedValueOnce([{ id: 'existing' }]); // duplicate found

      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'employee_id',
          display_label: 'Employee ID',
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should reject validation_rules larger than 4KB', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'test_field',
          display_label: 'Test',
          field_type: 'enum',
          validation_rules: {
            enum_values: Array.from({ length: 200 }, (_, i) => `val_${i}_${'x'.repeat(20)}`),
          },
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(400);
    });

    it('should reject required_scopes with more than 50 items', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'test_field',
          display_label: 'Test',
          required_scopes: Array.from({ length: 51 }, (_, i) => `scope_${i}`),
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(400);
    });

    it('should reject enum_values with more than 100 items', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'test_field',
          display_label: 'Test',
          field_type: 'enum',
          validation_rules: { enum_values: Array.from({ length: 101 }, (_, i) => `v${i}`) },
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should reject unsafe regex patterns (ReDoS)', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'test_field',
          display_label: 'Test',
          field_type: 'string',
          validation_rules: { pattern: '(a+)+$' },
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(400);
    });

    it('should accept safe regex patterns', async () => {
      mockDbQuery
        .mockResolvedValueOnce([]) // no duplicate
        .mockResolvedValueOnce([createSchemaRow({ id: 'test-id-123' })]); // fetch created
      mockDbExecute.mockResolvedValue({ rowsAffected: 1 });

      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'test_field',
          display_label: 'Test',
          field_type: 'string',
          validation_rules: { pattern: '^[a-z0-9]+$', min_length: 1, max_length: 100 },
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(201);
    });

    it('should reject claim_namespace without http/https scheme', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'test_field',
          display_label: 'Test',
          claim_namespace: 'ftp://example.com/',
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should accept valid claim_namespace and normalize trailing slash', async () => {
      mockDbQuery
        .mockResolvedValueOnce([]) // no duplicate
        .mockResolvedValueOnce([
          createSchemaRow({
            id: 'test-id-123',
            claim_namespace: 'https://example.com/claims/',
          }),
        ]);
      mockDbExecute.mockResolvedValue({ rowsAffected: 1 });

      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'test_field',
          display_label: 'Test',
          claim_namespace: 'https://example.com/claims',
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(201);
      // Verify normalized namespace was passed to INSERT
      const insertCall = mockDbExecute.mock.calls[0];
      expect(insertCall[1]).toContain('https://example.com/claims/');
    });

    it('should reject invalid scope_mode', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'test_field',
          display_label: 'Test',
          scope_mode: 'invalid',
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(400);
    });

    it('should clear registration_required when signup visibility is disabled on create', async () => {
      mockDbQuery
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([createSchemaRow({ id: 'test-id-123' })]);
      mockDbExecute.mockResolvedValue({ rowsAffected: 1 });

      const c = createMockContext({
        method: 'POST',
        body: {
          field_key: 'employee_id',
          display_label: 'Employee ID',
          field_type: 'string',
          is_pii: false,
          show_on_registration: false,
          registration_required: true,
        },
      });

      const res = await adminCustomClaimCreateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(201);
      expect(mockDbExecute.mock.calls[0][1].slice(-4)).toEqual([0, 0, 0, null]);
    });
  });

  // ===========================================================================
  // RESERVED NAMES
  // ===========================================================================

  describe('GET /api/admin/custom-claims/reserved-names', () => {
    it('should return sorted list of reserved names', async () => {
      const c = createMockContext({});
      const res = await adminCustomClaimsReservedNamesHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.reserved_names).toBeInstanceOf(Array);
      expect(body.reserved_names).toContain('sub');
      expect(body.reserved_names).toContain('email');
      // Verify sorted
      const sorted = [...body.reserved_names].sort();
      expect(body.reserved_names).toEqual(sorted);
    });
  });

  // ===========================================================================
  // STATS
  // ===========================================================================

  describe('GET /api/admin/custom-claims/stats', () => {
    it('should return stats from DB and cache result', async () => {
      mockDbQuery
        .mockResolvedValueOnce([{ count: 5 }]) // total
        .mockResolvedValueOnce([{ count: 3 }]) // non-pii
        .mockResolvedValueOnce([{ count: 2 }]) // pii
        .mockResolvedValueOnce([{ count: 10 }]) // non-pii users
        .mockResolvedValueOnce([]) // field usage
        .mockResolvedValueOnce([{ count: 0 }]); // error count
      mockPiiQuery.mockResolvedValueOnce([{ count: 7 }]); // pii users

      const mockKV = createMockKV();
      const c = createMockContext({ kv: mockKV });
      const res = await adminCustomClaimsStatsHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.total).toBe(5);
      expect(body.active_non_pii).toBe(3);
      expect(body.active_pii).toBe(2);
      expect(body.pii_users_approximate).toBe(true);
      // Verify KV cache was written
      expect(mockKV.put).toHaveBeenCalled();
    });

    it('should return cached stats when available', async () => {
      const cachedStats = { total: 10, active_non_pii: 5 };
      const mockKV = createMockKV();
      mockKV._store.set('custom_claim_stats:test-tenant', JSON.stringify(cachedStats));

      const c = createMockContext({ kv: mockKV });
      const res = await adminCustomClaimsStatsHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.total).toBe(10);
      // DB should not have been queried
      expect(mockDbQuery).not.toHaveBeenCalled();
    });

    it('should handle corrupted cache and regenerate', async () => {
      const mockKV = createMockKV();
      mockKV._store.set('custom_claim_stats:test-tenant', 'invalid-json{{{');

      mockDbQuery
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);
      mockPiiQuery.mockResolvedValueOnce([{ count: 0 }]);

      const c = createMockContext({ kv: mockKV });
      const res = await adminCustomClaimsStatsHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.total).toBe(1);
      // Cache was deleted then re-written
      expect(mockKV.delete).toHaveBeenCalled();
    });
  });

  describe('POST /api/admin/custom-claims/required-violations/detect', () => {
    it('should rescan active users and return violating previews', async () => {
      mockDbQuery.mockResolvedValueOnce([
        { id: 'user-1' },
        { id: 'user-2' },
      ]);
      mockGetRequiredCustomClaimViolationStatuses.mockResolvedValue({
        requiredSchemaCount: 1,
        users: [
          {
            userId: 'user-1',
            lifecycleState: 'incomplete',
            missingRequiredFields: [
              {
                fieldKey: 'department',
                label: 'Department',
                fieldType: 'string',
              },
            ],
          },
          {
            userId: 'user-2',
            lifecycleState: 'active',
            missingRequiredFields: [],
          },
        ],
      });
      mockPiiQuery.mockResolvedValueOnce([
        { id: 'user-1', email: 'missing@example.com', name: 'Missing User' },
      ]);

      const c = createMockContext({
        method: 'POST',
        query: { limit: '5' },
      });
      const res = await adminCustomClaimRequiredViolationsDetectHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.summary.scanned_users).toBe(2);
      expect(body.summary.violating_users).toBe(1);
      expect(body.summary.required_schema_count).toBe(1);
      expect(body.violations).toEqual([
        {
          user_id: 'user-1',
          email: 'missing@example.com',
          name: 'Missing User',
          lifecycle_state: 'incomplete',
          missing_required_fields: [
            {
              field_key: 'department',
              label: 'Department',
              field_type: 'string',
            },
          ],
        },
      ]);
      expect(mockGetRequiredCustomClaimViolationStatuses).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'test-tenant',
          userIds: ['user-1', 'user-2'],
          syncLifecycleState: true,
        })
      );
    });

    it('should return empty results when there are no active users to scan', async () => {
      mockDbQuery.mockResolvedValueOnce([]);

      const c = createMockContext({
        method: 'POST',
      });
      const res = await adminCustomClaimRequiredViolationsDetectHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.summary.scanned_users).toBe(0);
      expect(body.summary.violating_users).toBe(0);
      expect(body.violations).toEqual([]);
      expect(mockPiiQuery).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // GET SINGLE
  // ===========================================================================

  describe('GET /api/admin/custom-claims/:id', () => {
    it('should return schema with user count', async () => {
      mockDbQuery
        .mockResolvedValueOnce([createSchemaRow()]) // schema
        .mockResolvedValueOnce([{ count: 5 }]); // user count

      const c = createMockContext({ params: { id: 'schema-1' } });
      const res = await adminCustomClaimGetHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.schema.field_key).toBe('employee_id');
      expect(body.user_count).toBe(5);
      expect(body.user_count_approximate).toBe(false);
    });

    it('should return 404 for non-existent schema', async () => {
      mockDbQuery.mockResolvedValueOnce([]);

      const c = createMockContext({ params: { id: 'nonexistent' } });
      const res = await adminCustomClaimGetHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(404);
    });

    it('should return approximate count for PII schema', async () => {
      mockDbQuery.mockResolvedValueOnce([createSchemaRow({ is_pii: 1 })]);
      mockPiiQuery.mockResolvedValueOnce([{ count: 42 }]);

      const c = createMockContext({ params: { id: 'schema-1' } });
      const res = await adminCustomClaimGetHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.user_count).toBe(42);
      expect(body.user_count_approximate).toBe(true);
    });
  });

  // ===========================================================================
  // UPDATE
  // ===========================================================================

  describe('PUT /api/admin/custom-claims/:id (Update)', () => {
    it('should update schema fields', async () => {
      mockDbQuery
        .mockResolvedValueOnce([createSchemaRow()]) // fetch existing
        .mockResolvedValueOnce([createSchemaRow({ display_label: 'Updated Label' })]); // fetch updated
      mockDbExecute.mockResolvedValue({ rowsAffected: 1 });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'schema-1' },
        body: { display_label: 'Updated Label' },
      });

      const res = await adminCustomClaimUpdateHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.schema).toBeDefined();
    });

    it('should reject is_pii change', async () => {
      mockDbQuery.mockResolvedValueOnce([createSchemaRow({ is_pii: 0 })]);

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'schema-1' },
        body: { is_pii: true },
      });

      const res = await adminCustomClaimUpdateHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should reject field_key change (must use rename)', async () => {
      mockDbQuery.mockResolvedValueOnce([createSchemaRow()]);

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'schema-1' },
        body: { field_key: 'new_key' },
      });

      const res = await adminCustomClaimUpdateHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should block updates during non-active operation', async () => {
      mockDbQuery.mockResolvedValueOnce([createSchemaRow({ operation_status: 'renaming' })]);

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'schema-1' },
        body: { display_label: 'Test' },
      });

      const res = await adminCustomClaimUpdateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(400);
    });

    it('should reject empty update body', async () => {
      mockDbQuery.mockResolvedValueOnce([createSchemaRow()]);

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'schema-1' },
        body: {},
      });

      const res = await adminCustomClaimUpdateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(400);
    });

    it('should clear registration_required when signup visibility is disabled on update', async () => {
      mockDbQuery
        .mockResolvedValueOnce([createSchemaRow({ show_on_registration: 1, registration_required: 1 })])
        .mockResolvedValueOnce([
          createSchemaRow({ show_on_registration: 0, registration_required: 0 }),
        ]);
      mockDbExecute.mockResolvedValue({ rowsAffected: 1 });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'schema-1' },
        body: {
          show_on_registration: false,
          registration_required: true,
        },
      });

      const res = await adminCustomClaimUpdateHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(mockDbExecute.mock.calls[0][0]).toContain('registration_required = ?');
      expect(mockDbExecute.mock.calls[0][1]).toContain(0);
    });
  });

  // ===========================================================================
  // DELETE (2-phase)
  // ===========================================================================

  describe('DELETE /api/admin/custom-claims/:id (2-phase)', () => {
    it('should delete non-PII schema with cascade', async () => {
      mockDbQuery.mockResolvedValueOnce([createSchemaRow()]);
      mockDbExecute.mockResolvedValue({ rowsAffected: 1 });

      const c = createMockContext({
        method: 'DELETE',
        params: { id: 'schema-1' },
      });

      const res = await adminCustomClaimDeleteHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.deleted_id).toBe('schema-1');
      // Phase 1: mark as deleting (CAS)
      expect(mockDbExecute.mock.calls[0][0]).toContain('UPDATE custom_claim_schemas SET');
      expect(mockDbExecute.mock.calls[0][1]).toEqual([
        'deleting',
        expect.any(Number),
        'schema-1',
        'test-tenant',
        'active',
        'error',
      ]);
      // Phase 2: delete user data
      expect(mockDbExecute.mock.calls[1][0]).toContain('DELETE FROM user_custom_fields');
      // Phase 3: delete schema
      expect(mockDbExecute.mock.calls[2][0]).toContain('DELETE FROM custom_claim_schemas');
    });

    it('should use CAS pattern and fail on concurrent modification', async () => {
      mockDbQuery.mockResolvedValueOnce([createSchemaRow()]);
      mockDbExecute.mockResolvedValueOnce({ rowsAffected: 0 }); // CAS failure

      const c = createMockContext({
        method: 'DELETE',
        params: { id: 'schema-1' },
      });

      const res = await adminCustomClaimDeleteHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should handle PII delete with partial failure → error state', async () => {
      const mockKV = createMockKV();
      mockDbQuery.mockResolvedValueOnce([createSchemaRow({ is_pii: 1 })]);
      mockDbExecute.mockResolvedValue({ rowsAffected: 1 }); // CAS success

      // PII batch: 2 users, one fails
      mockPiiQuery.mockResolvedValueOnce([
        { id: 'user-1', custom_attributes_json: '{"employee_id":"val1"}' },
        { id: 'user-2', custom_attributes_json: '{bad-json' },
      ]);
      mockPiiExecute.mockResolvedValueOnce({ rowsAffected: 1 }); // user-1 success
      // user-2 will fail on JSON.parse

      const c = createMockContext({
        method: 'DELETE',
        params: { id: 'schema-1' },
        kv: mockKV,
      });

      const res = await adminCustomClaimDeleteHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(500);
      expect(body.success).toBe(false);
      // Should have set error state
      const errorUpdateCall = mockDbExecute.mock.calls.find(
        (call: unknown[]) => Array.isArray(call[1]) && call[1][0] === 'error'
      );
      expect(errorUpdateCall).toBeDefined();
      expect(mockKV.delete).toHaveBeenCalledWith('custom_claim_schemas:test-tenant');
    });

    it('should block delete during renaming operation', async () => {
      mockDbQuery.mockResolvedValueOnce([createSchemaRow({ operation_status: 'renaming' })]);

      const c = createMockContext({
        method: 'DELETE',
        params: { id: 'schema-1' },
      });

      const res = await adminCustomClaimDeleteHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(400);
    });
  });

  // ===========================================================================
  // RENAME (2-phase)
  // ===========================================================================

  describe('PATCH /api/admin/custom-claims/:id/rename (2-phase)', () => {
    it('should rename non-PII field_key', async () => {
      mockDbQuery
        .mockResolvedValueOnce([createSchemaRow()]) // fetch existing
        .mockResolvedValueOnce([]) // no conflict
        .mockResolvedValueOnce([createSchemaRow({ field_key: 'emp_id' })]); // fetch updated
      mockDbExecute
        .mockResolvedValueOnce({ rowsAffected: 1 }) // CAS: mark renaming
        .mockResolvedValueOnce({ rowsAffected: 5 }) // update user_custom_fields
        .mockResolvedValueOnce({ rowsAffected: 1 }); // atomic update

      const c = createMockContext({
        method: 'PATCH',
        params: { id: 'schema-1' },
        body: { new_field_key: 'emp_id' },
      });

      const res = await adminCustomClaimRenameHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.old_key).toBe('employee_id');
      expect(body.new_key).toBe('emp_id');
      expect(body.affected_users).toBe(5);
    });

    it('should reject missing new_field_key', async () => {
      const c = createMockContext({
        method: 'PATCH',
        params: { id: 'schema-1' },
        body: {},
      });

      const res = await adminCustomClaimRenameHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(400);
    });

    it('should reject reserved claim name as new key', async () => {
      const c = createMockContext({
        method: 'PATCH',
        params: { id: 'schema-1' },
        body: { new_field_key: 'email' },
      });

      const res = await adminCustomClaimRenameHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should reject rename to same key', async () => {
      mockDbQuery.mockResolvedValueOnce([createSchemaRow()]);

      const c = createMockContext({
        method: 'PATCH',
        params: { id: 'schema-1' },
        body: { new_field_key: 'employee_id' },
      });

      const res = await adminCustomClaimRenameHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should reject rename if conflicting active key exists', async () => {
      mockDbQuery
        .mockResolvedValueOnce([createSchemaRow()]) // fetch existing
        .mockResolvedValueOnce([{ id: 'other-schema' }]); // conflict

      const c = createMockContext({
        method: 'PATCH',
        params: { id: 'schema-1' },
        body: { new_field_key: 'dept_code' },
      });

      const res = await adminCustomClaimRenameHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should use CAS and fail on concurrent modification', async () => {
      mockDbQuery.mockResolvedValueOnce([createSchemaRow()]).mockResolvedValueOnce([]); // no conflict
      mockDbExecute.mockResolvedValueOnce({ rowsAffected: 0 }); // CAS failure

      const c = createMockContext({
        method: 'PATCH',
        params: { id: 'schema-1' },
        body: { new_field_key: 'new_key' },
      });

      const res = await adminCustomClaimRenameHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should handle PII rename with partial failure → error state', async () => {
      const mockKV = createMockKV();
      mockDbQuery.mockResolvedValueOnce([createSchemaRow({ is_pii: 1 })]).mockResolvedValueOnce([]); // no conflict
      mockDbExecute.mockResolvedValue({ rowsAffected: 1 }); // CAS success

      // PII batch: 2 users, one fails
      mockPiiQuery.mockResolvedValueOnce([
        { id: 'user-1', custom_attributes_json: '{"employee_id":"val1"}' },
        { id: 'user-2', custom_attributes_json: '{corrupt' },
      ]);
      mockPiiExecute.mockResolvedValue({ rowsAffected: 1 });

      const c = createMockContext({
        method: 'PATCH',
        params: { id: 'schema-1' },
        body: { new_field_key: 'emp_id' },
        kv: mockKV,
      });

      const res = await adminCustomClaimRenameHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(500);
      expect(body.success).toBe(false);
      expect(mockKV.delete).toHaveBeenCalledWith('custom_claim_schemas:test-tenant');
    });
  });

  // ===========================================================================
  // RETRY
  // ===========================================================================

  describe('POST /api/admin/custom-claims/:id/retry', () => {
    it('should reset delete error to active state', async () => {
      const mockKV = createMockKV();
      mockDbQuery.mockResolvedValueOnce([
        createSchemaRow({
          operation_status: 'error',
          operation_detail: JSON.stringify({ operation: 'delete', field_key: 'test' }),
        }),
      ]);
      mockDbExecute.mockResolvedValue({ rowsAffected: 1 });

      const c = createMockContext({
        method: 'POST',
        params: { id: 'schema-1' },
        kv: mockKV,
      });

      const res = await adminCustomClaimRetryHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.action).toBe('reset_to_active');
      expect(mockKV.delete).toHaveBeenCalledWith('custom_claim_schemas:test-tenant');
    });

    it('should retry rename operation', async () => {
      const mockKV = createMockKV();
      mockDbQuery.mockResolvedValueOnce([
        createSchemaRow({
          operation_status: 'error',
          operation_detail: JSON.stringify({
            operation: 'rename',
            old_key: 'old_field',
            new_key: 'new_field',
          }),
        }),
      ]);
      mockDbExecute.mockResolvedValue({ rowsAffected: 1 });
      // Non-PII: check remaining then update
      mockDbQuery
        .mockResolvedValueOnce([{ count: 3 }]) // remaining count
        .mockResolvedValueOnce([createSchemaRow({ field_key: 'new_field' })]); // fetch updated
      mockDbExecute
        .mockResolvedValueOnce({ rowsAffected: 1 }) // CAS: mark renaming
        .mockResolvedValueOnce({ rowsAffected: 3 }) // update user_custom_fields
        .mockResolvedValueOnce({ rowsAffected: 1 }); // atomic update

      const c = createMockContext({
        method: 'POST',
        params: { id: 'schema-1' },
        kv: mockKV,
      });

      const res = await adminCustomClaimRetryHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.action).toBe('rename_completed');
      expect(mockSchemaHistoryRecordChange).toHaveBeenCalledTimes(1);
      expect(mockKV.delete).toHaveBeenCalledWith('custom_claim_schemas:test-tenant');
    });

    it('should reject retry on non-error schema', async () => {
      mockDbQuery.mockResolvedValueOnce([createSchemaRow({ operation_status: 'active' })]);

      const c = createMockContext({
        method: 'POST',
        params: { id: 'schema-1' },
      });

      const res = await adminCustomClaimRetryHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(400);
      expect(body.error_code).toBe('AR130002');
    });

    it('should handle unparseable operation_detail by resetting to active', async () => {
      const mockKV = createMockKV();
      mockDbQuery.mockResolvedValueOnce([
        createSchemaRow({
          operation_status: 'error',
          operation_detail: 'not-valid-json{{{',
        }),
      ]);
      mockDbExecute.mockResolvedValue({ rowsAffected: 1 });

      const c = createMockContext({
        method: 'POST',
        params: { id: 'schema-1' },
        kv: mockKV,
      });

      const res = await adminCustomClaimRetryHandler(c);
      const { body, status } = await getResponseData(res);

      expect(status).toBe(200);
      expect(body.action).toBe('reset_to_active');
      expect(mockKV.delete).toHaveBeenCalledWith('custom_claim_schemas:test-tenant');
    });

    it('should return 404 for non-existent schema', async () => {
      mockDbQuery.mockResolvedValueOnce([]);

      const c = createMockContext({
        method: 'POST',
        params: { id: 'nonexistent' },
      });

      const res = await adminCustomClaimRetryHandler(c);
      const { status } = await getResponseData(res);

      expect(status).toBe(404);
    });
  });
});
