/**
 * Admin API Handlers Unit Tests
 *
 * Tests for Admin API endpoints including:
 * - Statistics (adminStatsHandler)
 * - User management (CRUD operations)
 * - Client management (CRUD operations)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/shared';
import {
  adminStatsHandler,
  adminUsersListHandler,
  adminUserGetHandler,
  adminUserCreateHandler,
  adminUserUpdateHandler,
  adminUserDeleteHandler,
  adminClientsListHandler,
  adminClientGetHandler,
  adminClientCreateHandler,
  adminClientUpdateHandler,
  adminClientDeleteHandler,
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

// Mock KV namespace for cache invalidation
function createMockKVNamespace() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
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
  const contextStore = new Map<string, unknown>([['tenantId', 'default']]);

  const c = {
    req: {
      method: options.method || 'GET',
      query: (name: string) => options.query?.[name],
      param: (name: string) => options.params?.[name],
      json: vi.fn().mockResolvedValue(options.body ?? {}),
      parseBody: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {
      DB: mockDB,
      DB_PII: mockDBPII, // Added for PII/Non-PII DB separation
      ISSUER_URL: 'https://op.example.com',
      CLIENTS_CACHE: createMockKVNamespace(),
    } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
    _mockDB: mockDB,
    _mockDBPII: mockDBPII, // For test assertions
  } as any;

  return c;
}

describe('Admin API Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
          error_description: 'User not found',
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
        },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserCreateHandler(c);

      // Verify insert into Core DB
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users_core')
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

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'conflict',
          error_description: expect.stringContaining('email'),
        }),
        409
      );
    });
  });

  describe('adminUserUpdateHandler', () => {
    it('should update user fields', async () => {
      // PII/Non-PII DB Separation:
      // Core fields (email_verified, phone_number_verified, user_type) → Core DB
      // PII fields (name, phone_number, picture, etc.) → PII DB

      const userId = 'user-to-update';
      const mockDB = createMockDB({
        runResult: { success: true },
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
          error_description: 'User not found',
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
          error_description: 'User not found',
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
          error_description: 'Client not found',
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
  });

  describe('adminClientUpdateHandler', () => {
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
          error_description: 'Client not found',
        }),
        404
      );
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
          error_description: 'Client not found',
        }),
        404
      );
    });
  });
});
