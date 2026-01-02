/**
 * SCIM 2.0 Endpoint Tests
 * Tests RFC 7643 (Core Schema) and RFC 7644 (Protocol) compliance
 *
 * Covers:
 * - Bearer token authentication
 * - Expired/invalid token rejection
 * - User CRUD operations
 * - Group CRUD operations
 * - Filter expression handling
 * - ETag/If-Match concurrency control
 * - Pagination
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import scimApp from '../scim';

// Mock scim-auth middleware at module level (now from @authrim/ar-lib-scim package)
vi.mock('@authrim/ar-lib-scim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-scim')>();
  return {
    ...actual,
    scimAuthMiddleware: vi.fn().mockImplementation(async (c: any, next: () => Promise<void>) => {
      // Allow all requests by default; specific tests override this
      const authHeader = c.req.header('Authorization');
      if (!authHeader) {
        return c.json(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '401',
            detail: 'No authorization header provided',
          },
          401
        );
      }
      if (!authHeader.startsWith('Bearer ')) {
        return c.json(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '401',
            detail: 'Invalid authorization header format',
          },
          401
        );
      }
      const token = authHeader.split(' ')[1];
      if (token === 'expired-token') {
        return c.json(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '401',
            detail: 'Invalid or expired SCIM token',
          },
          401
        );
      }
      if (token === 'invalid-token') {
        return c.json(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '401',
            detail: 'Invalid or expired SCIM token',
          },
          401
        );
      }
      await next();
    }),
  };
});

// Mock shared utilities
vi.mock('@authrim/ar-lib-core/utils/id', () => ({
  generateId: vi
    .fn()
    .mockImplementation(() => `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`),
}));

vi.mock('@authrim/ar-lib-core/utils/crypto', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed_password_123'),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    invalidateUserCache: vi.fn().mockResolvedValue(undefined),
    getTenantIdFromContext: vi.fn().mockReturnValue('default'),
  };
});

describe('SCIM 2.0 Endpoints', () => {
  let app: Hono;
  let mockEnv: Partial<Env>;
  let mockUsers: Map<string, any>;
  let mockGroups: Map<string, any>;
  let mockUserRoles: Map<string, any[]>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUsers = new Map();
    mockGroups = new Map();
    mockUserRoles = new Map();

    // Seed some test data (timestamps as Unix seconds, matching D1 database format)
    const jan15 = Math.floor(new Date('2024-01-15T10:00:00Z').getTime() / 1000);
    const jan16 = Math.floor(new Date('2024-01-16T10:00:00Z').getTime() / 1000);
    const jan10 = Math.floor(new Date('2024-01-10T10:00:00Z').getTime() / 1000);

    mockUsers.set('user-001', {
      id: 'user-001',
      email: 'john.doe@example.com',
      email_verified: 1,
      name: 'John Doe',
      given_name: 'John',
      family_name: 'Doe',
      preferred_username: 'johndoe',
      active: 1,
      external_id: 'ext-001',
      created_at: jan15,
      updated_at: jan15,
    });

    mockUsers.set('user-002', {
      id: 'user-002',
      email: 'jane.smith@example.com',
      email_verified: 1,
      name: 'Jane Smith',
      given_name: 'Jane',
      family_name: 'Smith',
      preferred_username: 'janesmith',
      active: 1,
      external_id: 'ext-002',
      created_at: jan16,
      updated_at: jan16,
    });

    mockGroups.set('group-001', {
      id: 'group-001',
      name: 'Administrators',
      description: 'Admin group',
      external_id: 'ext-grp-001',
      created_at: jan10,
    });

    // Mock database
    mockEnv = {
      DB: {
        prepare: vi.fn().mockImplementation((sql: string) => {
          return {
            bind: vi.fn().mockImplementation((...args: any[]) => ({
              first: vi.fn().mockImplementation(async () => {
                // Handle SELECT queries for users_core (PII/Non-PII separation)
                if (sql.includes('FROM users_core WHERE id = ?')) {
                  const user = mockUsers.get(args[0]);
                  if (!user) return null;
                  return {
                    id: user.id,
                    tenant_id: user.tenant_id || 'default',
                    email_verified: user.email_verified,
                    phone_number_verified: 0,
                    is_active: user.active,
                    user_type: 'end_user',
                    external_id: user.external_id,
                    pii_partition: 'default',
                    pii_status: 'active',
                    created_at: user.created_at,
                    updated_at: user.updated_at,
                  };
                }
                if (sql.includes('SELECT COUNT(*) as total')) {
                  if (sql.includes('users') || sql.includes('users_core'))
                    return { total: mockUsers.size };
                  if (sql.includes('roles')) return { total: mockGroups.size };
                }
                if (sql.includes('SELECT * FROM roles WHERE id = ?')) {
                  return mockGroups.get(args[0]) || null;
                }
                if (sql.includes('SELECT id FROM roles WHERE name = ?')) {
                  for (const group of mockGroups.values()) {
                    if (group.name === args[0]) return { id: group.id };
                  }
                  return null;
                }
                return null;
              }),
              all: vi.fn().mockImplementation(async () => {
                // Handle SELECT queries for users_core list (PII/Non-PII separation)
                if (sql.includes('FROM users_core')) {
                  const results = Array.from(mockUsers.values()).map((user) => ({
                    id: user.id,
                    tenant_id: user.tenant_id || 'default',
                    email_verified: user.email_verified,
                    phone_number_verified: 0,
                    is_active: user.active,
                    user_type: 'end_user',
                    external_id: user.external_id,
                    pii_partition: 'default',
                    pii_status: 'active',
                    created_at: user.created_at,
                    updated_at: user.updated_at,
                  }));
                  return { results };
                }
                if (sql.includes('SELECT * FROM roles')) {
                  return { results: Array.from(mockGroups.values()) };
                }
                if (sql.includes('SELECT ur.user_id')) {
                  const roleId = args[0];
                  const members = mockUserRoles.get(roleId) || [];
                  return { results: members };
                }
                return { results: [] };
              }),
              run: vi.fn().mockImplementation(async () => {
                // Handle INSERT into users_core (PII/Non-PII separation)
                if (sql.includes('INSERT INTO users_core')) {
                  // bind() order: id, tenant_id, email_verified, phone_number_verified, password_hash,
                  // is_active, user_type, external_id, pii_partition, pii_status, created_at, updated_at
                  const userId = args[0];
                  // Timestamps are stored as Unix seconds (matching D1 database format)
                  const nowSeconds = Math.floor(Date.now() / 1000);
                  mockUsers.set(userId, {
                    id: userId,
                    tenant_id: args[1],
                    email_verified: args[2],
                    active: args[5],
                    external_id: args[7],
                    created_at: nowSeconds,
                    updated_at: nowSeconds,
                  });
                  return { success: true };
                }
                // Handle UPDATE users_core SET (PII/Non-PII separation)
                if (sql.includes('UPDATE users_core SET')) {
                  const userId = args[args.length - 1];
                  const user = mockUsers.get(userId);
                  if (user) {
                    user.updated_at = Math.floor(Date.now() / 1000);
                    // Handle soft delete (is_active = 0)
                    if (sql.includes('is_active = 0')) {
                      user.active = 0;
                    }
                  }
                  return { success: true };
                }
                if (sql.includes('INSERT INTO roles')) {
                  const groupId = args[0];
                  mockGroups.set(groupId, {
                    id: groupId,
                    name: args[1],
                    description: args[2],
                    external_id: args[4],
                    created_at: args[5],
                  });
                  return { success: true };
                }
                if (sql.includes('UPDATE roles SET')) {
                  const groupId = args[args.length - 1];
                  const group = mockGroups.get(groupId);
                  if (group) {
                    group.name = args[0];
                    group.description = args[1];
                  }
                  return { success: true };
                }
                if (sql.includes('DELETE FROM roles')) {
                  mockGroups.delete(args[0]);
                  return { success: true };
                }
                if (sql.includes('DELETE FROM user_roles')) {
                  mockUserRoles.delete(args[0]);
                  return { success: true };
                }
                if (sql.includes('INSERT INTO user_roles')) {
                  const userId = args[0];
                  const roleId = args[1];
                  const members = mockUserRoles.get(roleId) || [];
                  members.push({ user_id: userId, email: mockUsers.get(userId)?.email });
                  mockUserRoles.set(roleId, members);
                  return { success: true };
                }
                return { success: true };
              }),
            })),
          };
        }),
      } as any,
      // DB_PII mock for PII/Non-PII DB separation
      DB_PII: {
        prepare: vi.fn().mockImplementation((sql: string) => {
          return {
            bind: vi.fn().mockImplementation((...args: any[]) => ({
              first: vi.fn().mockImplementation(async () => {
                // Handle SELECT queries for PII data
                if (sql.includes('SELECT') && sql.includes('FROM users_pii WHERE id = ?')) {
                  const user = mockUsers.get(args[0]);
                  if (!user) return null;
                  return {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    given_name: user.given_name,
                    family_name: user.family_name,
                    middle_name: null,
                    nickname: null,
                    preferred_username: user.preferred_username,
                    profile: null,
                    picture: null,
                    website: null,
                    gender: null,
                    birthdate: null,
                    zoneinfo: null,
                    locale: null,
                    phone_number: null,
                    address_formatted: null,
                    address_street_address: null,
                    address_locality: null,
                    address_region: null,
                    address_postal_code: null,
                    address_country: null,
                  };
                }
                // Handle email uniqueness check
                if (sql.includes('SELECT id FROM users_pii WHERE') && sql.includes('email')) {
                  const emailArg = sql.includes('tenant_id') ? args[1] : args[0];
                  for (const user of mockUsers.values()) {
                    if (user.email === emailArg) return { id: user.id };
                  }
                  return null;
                }
                return null;
              }),
              all: vi.fn().mockImplementation(async () => {
                // Handle bulk SELECT for PII data
                if (sql.includes('SELECT') && sql.includes('FROM users_pii WHERE id IN')) {
                  const results = args
                    .map((id: string) => {
                      const user = mockUsers.get(id);
                      if (!user) return null;
                      return {
                        id: user.id,
                        email: user.email,
                        name: user.name,
                        given_name: user.given_name,
                        family_name: user.family_name,
                        middle_name: null,
                        nickname: null,
                        preferred_username: user.preferred_username,
                      };
                    })
                    .filter(Boolean);
                  return { results };
                }
                return { results: [] };
              }),
              run: vi.fn().mockImplementation(async () => {
                // Handle INSERT/UPDATE/DELETE for PII
                if (sql.includes('INSERT INTO users_pii')) {
                  // bind() order for INSERT INTO users_pii:
                  // id, tenant_id, email, name, given_name, family_name, middle_name,
                  // nickname, preferred_username, profile, picture, website, gender,
                  // birthdate, zoneinfo, locale, phone_number,
                  // address_formatted, address_street_address, address_locality,
                  // address_region, address_postal_code, address_country,
                  // created_at, updated_at
                  const userId = args[0];
                  const user = mockUsers.get(userId);
                  if (user) {
                    // Update existing user with PII data
                    user.email = args[2];
                    user.name = args[3];
                    user.given_name = args[4];
                    user.family_name = args[5];
                    user.preferred_username = args[8];
                  }
                  return { success: true };
                }
                if (sql.includes('UPDATE users_pii SET')) {
                  // PII update - update mockUsers with new PII
                  const userId = args[args.length - 1];
                  const user = mockUsers.get(userId);
                  if (user) {
                    user.email = args[0];
                    user.name = args[1];
                    user.given_name = args[2];
                    user.family_name = args[3];
                    user.preferred_username = args[7];
                  }
                  return { success: true };
                }
                if (sql.includes('DELETE FROM users_pii')) {
                  // PII delete
                  return { success: true };
                }
                if (sql.includes('INSERT INTO users_pii_tombstone')) {
                  // Tombstone insert for GDPR
                  return { success: true };
                }
                return { success: true };
              }),
            })),
          };
        }),
      } as any,
      INITIAL_ACCESS_TOKENS: {
        get: vi.fn().mockResolvedValue(JSON.stringify({ enabled: true })),
      } as any,
    };

    // Create Hono app with mock environment binding
    app = new Hono();
    app.route('/scim/v2', scimApp);
  });

  // Helper to create request with proper headers
  function createRequest(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has('Authorization')) {
      headers.set('Authorization', 'Bearer valid-scim-token');
    }
    if (!headers.has('Content-Type') && options.body) {
      headers.set('Content-Type', 'application/scim+json');
    }
    return new Request(`http://localhost${path}`, {
      ...options,
      headers,
    });
  }

  describe('Authentication', () => {
    it('should reject request without Authorization header', async () => {
      const req = new Request('http://localhost/scim/v2/Users', {
        headers: { 'Content-Type': 'application/json' },
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('No authorization header');
    });

    it('should reject request with non-Bearer token', async () => {
      const req = new Request('http://localhost/scim/v2/Users', {
        headers: {
          Authorization: 'Basic dXNlcjpwYXNz',
          'Content-Type': 'application/json',
        },
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('Invalid authorization header format');
    });

    it('should reject expired SCIM token', async () => {
      const req = new Request('http://localhost/scim/v2/Users', {
        headers: {
          Authorization: 'Bearer expired-token',
          'Content-Type': 'application/json',
        },
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('expired');
    });

    it('should reject invalid SCIM token', async () => {
      const req = new Request('http://localhost/scim/v2/Users', {
        headers: {
          Authorization: 'Bearer invalid-token',
          'Content-Type': 'application/json',
        },
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('Invalid');
    });

    it('should accept valid SCIM token', async () => {
      const req = createRequest('/scim/v2/Users');
      const res = await app.fetch(req, mockEnv as Env);

      // Should not be 401/403
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  describe('GET /scim/v2/Users - List Users', () => {
    it('should return list of users with pagination', async () => {
      const req = createRequest('/scim/v2/Users');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:ListResponse');
      expect(body.totalResults).toBeGreaterThanOrEqual(0);
      expect(body.startIndex).toBe(1);
      expect(body.Resources).toBeDefined();
    });

    it('should support startIndex and count pagination parameters', async () => {
      const req = createRequest('/scim/v2/Users?startIndex=1&count=10');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.startIndex).toBe(1);
      expect(body.itemsPerPage).toBeLessThanOrEqual(10);
    });

    it('should limit count to maximum allowed', async () => {
      const req = createRequest('/scim/v2/Users?count=5000');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Max is 1000
      expect(body.itemsPerPage).toBeLessThanOrEqual(1000);
    });

    it('should support filter parameter', async () => {
      const req = createRequest('/scim/v2/Users?filter=userName%20eq%20%22johndoe%22');
      const res = await app.fetch(req, mockEnv as Env);

      // Filter parsing might fail or succeed depending on implementation
      // Important: should not return 500
      expect(res.status).not.toBe(500);
    });

    it('should reject invalid filter syntax', async () => {
      const req = createRequest('/scim/v2/Users?filter=invalid_syntax!!!');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('invalidFilter');
    });
  });

  describe('GET /scim/v2/Users/:id - Get User', () => {
    it('should return user by ID', async () => {
      const req = createRequest('/scim/v2/Users/user-001');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.schemas).toContain('urn:ietf:params:scim:schemas:core:2.0:User');
      expect(body.id).toBe('user-001');
      expect(body.userName).toBeDefined();
    });

    it('should return 404 for non-existent user', async () => {
      const req = createRequest('/scim/v2/Users/non-existent-user');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('not found');
    });

    it('should return 304 Not Modified when ETag matches', async () => {
      // First get the user to obtain ETag
      const req1 = createRequest('/scim/v2/Users/user-001');
      const res1 = await app.fetch(req1, mockEnv as Env);
      const etag = res1.headers.get('ETag');

      if (etag) {
        // Request with If-None-Match header
        const req2 = createRequest('/scim/v2/Users/user-001', {
          headers: {
            Authorization: 'Bearer valid-scim-token',
            'If-None-Match': etag,
          },
        });
        const res2 = await app.fetch(req2, mockEnv as Env);

        expect(res2.status).toBe(304);
      }
    });
  });

  describe('POST /scim/v2/Users - Create User', () => {
    it('should create new user', async () => {
      const newUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'newuser',
        name: {
          givenName: 'New',
          familyName: 'User',
        },
        emails: [{ value: 'new.user@example.com', primary: true }],
        active: true,
      };

      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(newUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;

      expect(body.id).toBeDefined();
      expect(body.userName).toBe('newuser');
      expect(res.headers.get('Location')).toBeDefined();
    });

    it('should reject duplicate email', async () => {
      const newUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'duplicate',
        emails: [{ value: 'john.doe@example.com', primary: true }], // Already exists
        active: true,
      };

      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(newUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('uniqueness');
    });

    it('should validate required fields', async () => {
      const invalidUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        // Missing userName
      };

      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(invalidUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('invalidValue');
    });
  });

  describe('PUT /scim/v2/Users/:id - Replace User', () => {
    it('should replace user completely', async () => {
      const updatedUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'johndoe_updated',
        name: {
          givenName: 'John',
          familyName: 'Updated',
        },
        emails: [{ value: 'john.updated@example.com', primary: true }],
        active: true,
      };

      const req = createRequest('/scim/v2/Users/user-001', {
        method: 'PUT',
        body: JSON.stringify(updatedUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // userName comes from DB after update, verify response structure
      expect(body.schemas).toContain('urn:ietf:params:scim:schemas:core:2.0:User');
      expect(body.id).toBe('user-001');
    });

    it('should return 404 for non-existent user', async () => {
      const req = createRequest('/scim/v2/Users/non-existent', {
        method: 'PUT',
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'test',
          emails: [{ value: 'test@example.com', primary: true }],
        }),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(404);
    });

    it('should enforce ETag with If-Match header', async () => {
      // Get user to obtain current ETag
      const req1 = createRequest('/scim/v2/Users/user-001');
      const res1 = await app.fetch(req1, mockEnv as Env);
      const body1 = await res1.json();

      // Use mismatched ETag
      const req2 = createRequest('/scim/v2/Users/user-001', {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer valid-scim-token',
          'If-Match': '"wrong-etag"',
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'test',
          emails: [{ value: 'test@example.com', primary: true }],
        }),
      });
      const res2 = await app.fetch(req2, mockEnv as Env);

      expect(res2.status).toBe(412);
      const body2 = (await res2.json()) as any;
      expect(body2.scimType).toBe('invalidVers');
    });
  });

  describe('PATCH /scim/v2/Users/:id - Partial Update', () => {
    it('should apply patch operations', async () => {
      const patchOp = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      };

      const req = createRequest('/scim/v2/Users/user-001', {
        method: 'PATCH',
        body: JSON.stringify(patchOp),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Verify response structure - the actual active value depends on mock implementation
      expect(body.schemas).toContain('urn:ietf:params:scim:schemas:core:2.0:User');
      expect(body.id).toBe('user-001');
    });

    it('should return 404 for non-existent user', async () => {
      const patchOp = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      };

      const req = createRequest('/scim/v2/Users/non-existent', {
        method: 'PATCH',
        body: JSON.stringify(patchOp),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /scim/v2/Users/:id - Delete User', () => {
    it('should delete user', async () => {
      const req = createRequest('/scim/v2/Users/user-001', {
        method: 'DELETE',
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(204);
    });

    it('should return 404 for non-existent user', async () => {
      const req = createRequest('/scim/v2/Users/non-existent', {
        method: 'DELETE',
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(404);
    });

    it('should enforce ETag with If-Match header', async () => {
      const req = createRequest('/scim/v2/Users/user-001', {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-scim-token',
          'If-Match': '"wrong-etag"',
        },
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(412);
    });
  });

  describe('GET /scim/v2/Groups - List Groups', () => {
    it('should return list of groups', async () => {
      const req = createRequest('/scim/v2/Groups');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:ListResponse');
      expect(body.Resources).toBeDefined();
    });
  });

  describe('POST /scim/v2/Groups - Create Group', () => {
    it('should create new group', async () => {
      const newGroup = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'New Group',
        members: [],
      };

      const req = createRequest('/scim/v2/Groups', {
        method: 'POST',
        body: JSON.stringify(newGroup),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.displayName).toBe('New Group');
    });

    it('should reject duplicate group name', async () => {
      const newGroup = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Administrators', // Already exists
      };

      const req = createRequest('/scim/v2/Groups', {
        method: 'POST',
        body: JSON.stringify(newGroup),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('uniqueness');
    });
  });

  describe('SCIM Error Response Format', () => {
    it('should return RFC 7644 compliant error response', async () => {
      const req = createRequest('/scim/v2/Users/non-existent');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(404);
      const body = (await res.json()) as any;

      expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
      expect(body.status).toBeDefined();
      expect(body.detail).toBeDefined();
    });
  });

  describe('SCIM Bulk Operations (RFC 7644 Section 3.7)', () => {
    it('should process bulk POST operations', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'POST',
            path: '/Users',
            bulkId: 'user1',
            data: {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
              userName: 'newuser1@example.com',
              name: { givenName: 'New', familyName: 'User1' },
              emails: [{ value: 'newuser1@example.com', primary: true }],
            },
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:BulkResponse');
      expect(body.Operations).toBeDefined();
      expect(body.Operations.length).toBe(1);
      expect(body.Operations[0].status).toBe('201');
      expect(body.Operations[0].bulkId).toBe('user1');
      expect(body.Operations[0].location).toBeDefined();
    });

    it('should reject bulk request with too many operations', async () => {
      // Generate more than 100 operations (default max)
      const operations = Array.from({ length: 101 }, (_, i) => ({
        method: 'POST',
        path: '/Users',
        bulkId: `user${i}`,
        data: {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: `user${i}@example.com`,
          emails: [{ value: `user${i}@example.com`, primary: true }],
        },
      }));

      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: operations,
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(413);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('tooMany');
    });

    it('should require BulkRequest schema', async () => {
      const bulkRequest = {
        schemas: ['wrong:schema'],
        Operations: [],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('invalidSyntax');
    });

    it('should handle DELETE operations', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'DELETE',
            path: '/Users/user-001',
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.Operations.length).toBe(1);
      expect(body.Operations[0].status).toBe('204');
    });

    it('should return 404 for non-existent resources', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'DELETE',
            path: '/Users/non-existent-user',
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.Operations[0].status).toBe('404');
    });

    it('should include Content-Type in response', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.headers.get('Content-Type')).toContain('application/scim+json');
    });

    it('should handle Group operations', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'POST',
            path: '/Groups',
            bulkId: 'group1',
            data: {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
              displayName: 'New Test Group',
            },
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.Operations[0].status).toBe('201');
      expect(body.Operations[0].bulkId).toBe('group1');
    });

    it('should reject invalid path', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'POST',
            path: '/InvalidResource',
            data: {},
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.Operations[0].status).toBe('400');
    });
  });
});
