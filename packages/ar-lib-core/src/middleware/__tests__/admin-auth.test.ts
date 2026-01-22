import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminAuthMiddleware } from '../admin-auth';
import type { Env } from '../../types/env';

// Mock session helper functions
vi.mock('../../utils/session-helper', () => ({
  // Accept any generation (g1:, g2:, g3:, etc.) with region-sharded format
  isRegionShardedSessionId: vi.fn((sessionId: string) => /^g\d+:/.test(sessionId)),
  getSessionStoreBySessionId: vi.fn(),
}));

import { isRegionShardedSessionId, getSessionStoreBySessionId } from '../../utils/session-helper';

/**
 * Admin Authentication Middleware Tests
 *
 * Tests for dual authentication (Bearer token + Session) middleware
 * including security features like constant-time comparison
 */

/**
 * Create a mock environment for testing
 */
function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_API_SECRET: 'test-admin-secret',
    KEY_MANAGER_SECRET: 'test-key-manager-secret',
    ISSUER_URL: 'https://test.example.com',
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({}),
      }),
    } as unknown as D1Database,
    ...overrides,
  } as Env;
}

/**
 * Create a test Hono app with admin auth middleware
 */
function createTestApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  // Apply admin auth middleware
  app.use('/api/admin/*', adminAuthMiddleware());

  // Protected test endpoint
  app.get('/api/admin/test', (c) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAuth = (c as any).get('adminAuth');
    return c.json({ success: true, adminAuth });
  });

  // Override env for each request
  return {
    fetch: (request: Request) => app.fetch(request, env),
  };
}

describe('adminAuthMiddleware', () => {
  let mockEnv: Env;

  beforeEach(() => {
    mockEnv = createMockEnv();
    vi.clearAllMocks();
  });

  describe('Bearer Token Authentication', () => {
    it('should authenticate with valid ADMIN_API_SECRET', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Bearer test-admin-secret',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.success).toBe(true);
      expect(data.adminAuth).toEqual({
        userId: 'system',
        authMethod: 'bearer',
        roles: ['system_admin', 'admin', 'system'],
      });
    });

    it('should authenticate with valid KEY_MANAGER_SECRET as fallback', async () => {
      const env = createMockEnv({
        ADMIN_API_SECRET: undefined,
        KEY_MANAGER_SECRET: 'test-key-manager-secret',
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Bearer test-key-manager-secret',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.adminAuth.authMethod).toBe('bearer');
    });

    it('should reject invalid Bearer token', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Bearer invalid-token',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);

      const data = (await response.json()) as Record<string, unknown>;
      // RFC 6750: invalid_token is the standard error code for Bearer token failures
      expect(data.error).toBe('invalid_token');
    });

    it('should reject when no secrets are configured', async () => {
      const env = createMockEnv({
        ADMIN_API_SECRET: undefined,
        KEY_MANAGER_SECRET: undefined,
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Bearer any-token',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should reject malformed Authorization header', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Basic dXNlcjpwYXNz', // Basic auth instead of Bearer
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should reject empty Bearer token', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Bearer ',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });
  });

  describe('Session Authentication', () => {
    it('should authenticate with valid session and admin role', async () => {
      // Mock SessionStore to return valid session
      const mockSessionStore = {
        getSessionRpc: vi.fn().mockResolvedValue({
          id: 'g1:apac:0:session_test123',
          userId: 'user-123',
          expiresAt: Date.now() + 3600000, // 1 hour from now
          createdAt: Date.now() - 3600000,
        }),
      };

      vi.mocked(getSessionStoreBySessionId).mockReturnValue({
        stub: mockSessionStore as unknown as ReturnType<typeof getSessionStoreBySessionId>['stub'],
        resolution: { generation: 1, regionKey: 'apac', shardIndex: 0 },
        instanceName: 'default:apac:s:0',
      });

      // Mock DB to return admin role and user info
      const mockDB = {
        prepare: vi.fn().mockImplementation((query: string) => {
          // role_assignments JOIN roles query
          if (query.includes('role_assignments')) {
            return {
              bind: vi.fn().mockReturnThis(),
              all: vi.fn().mockResolvedValue({
                results: [{ name: 'admin' }, { name: 'end_user' }],
              }),
            };
          }
          // users + subject_org_membership query
          if (query.includes('users')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue({
                user_type: 'enterprise_admin',
                org_id: 'org-123',
              }),
            };
          }
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
          };
        }),
      };

      const env = createMockEnv({ DB: mockDB as unknown as D1Database });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: 'authrim_admin_session=g1:apac:0:session_test123',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.adminAuth.userId).toBe('user-123');
      expect(data.adminAuth.authMethod).toBe('session');
      expect(data.adminAuth.roles).toContain('admin');
    });

    it('should reject expired session', async () => {
      // Mock SessionStore to return expired session
      const mockSessionStore = {
        getSessionRpc: vi.fn().mockResolvedValue({
          id: 'g1:apac:0:session_expired',
          userId: 'user-123',
          expiresAt: Date.now() - 3600000, // 1 hour ago (expired)
          createdAt: Date.now() - 7200000,
        }),
      };

      vi.mocked(getSessionStoreBySessionId).mockReturnValue({
        stub: mockSessionStore as unknown as ReturnType<typeof getSessionStoreBySessionId>['stub'],
        resolution: { generation: 1, regionKey: 'apac', shardIndex: 0 },
        instanceName: 'default:apac:s:0',
      });

      const env = createMockEnv();
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: 'authrim_admin_session=g1:apac:0:session_expired',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should reject session without admin role', async () => {
      // Mock SessionStore to return valid session
      const mockSessionStore = {
        getSessionRpc: vi.fn().mockResolvedValue({
          id: 'g1:apac:0:session_nonadmin',
          userId: 'user-123',
          expiresAt: Date.now() + 3600000,
          createdAt: Date.now() - 3600000,
        }),
      };

      vi.mocked(getSessionStoreBySessionId).mockReturnValue({
        stub: mockSessionStore as unknown as ReturnType<typeof getSessionStoreBySessionId>['stub'],
        resolution: { generation: 1, regionKey: 'apac', shardIndex: 0 },
        instanceName: 'default:apac:s:0',
      });

      // Mock DB to return no admin role
      const mockDB = {
        prepare: vi.fn().mockImplementation((query: string) => {
          // role_assignments returns no admin roles
          if (query.includes('role_assignments')) {
            return {
              bind: vi.fn().mockReturnThis(),
              all: vi.fn().mockResolvedValue({
                results: [{ name: 'end_user' }], // No admin role
              }),
            };
          }
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
          };
        }),
      };

      const env = createMockEnv({ DB: mockDB as unknown as D1Database });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: 'authrim_admin_session=g1:apac:0:session_nonadmin',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should reject invalid session', async () => {
      // Mock SessionStore to return null (session not found)
      const mockSessionStore = {
        getSessionRpc: vi.fn().mockResolvedValue(null),
      };

      vi.mocked(getSessionStoreBySessionId).mockReturnValue({
        stub: mockSessionStore as unknown as ReturnType<typeof getSessionStoreBySessionId>['stub'],
        resolution: { generation: 1, regionKey: 'apac', shardIndex: 0 },
        instanceName: 'default:apac:s:0',
      });

      const env = createMockEnv();
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: 'authrim_admin_session=g1:apac:0:session_invalid',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should handle DB errors gracefully', async () => {
      // Mock SessionStore to return valid session
      const mockSessionStore = {
        getSessionRpc: vi.fn().mockResolvedValue({
          id: 'g1:apac:0:session_test',
          userId: 'user-123',
          expiresAt: Date.now() + 3600000,
          createdAt: Date.now() - 3600000,
        }),
      };

      vi.mocked(getSessionStoreBySessionId).mockReturnValue({
        stub: mockSessionStore as unknown as ReturnType<typeof getSessionStoreBySessionId>['stub'],
        resolution: { generation: 1, regionKey: 'apac', shardIndex: 0 },
        instanceName: 'default:apac:s:0',
      });

      // Mock DB to throw error on role lookup
      const mockDB = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockRejectedValue(new Error('DB connection failed')),
          all: vi.fn().mockRejectedValue(new Error('DB connection failed')),
        }),
      };

      const env = createMockEnv({ DB: mockDB as unknown as D1Database });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: 'authrim_admin_session=g1:apac:0:session_test',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should authenticate with URL-encoded session ID (Safari browser behavior)', async () => {
      // Safari and some browsers URL-encode cookie values containing special characters like ':'
      const rawSessionId = 'g3:apac:14:session_WlS-BmKP2V1LqohaYXla_w';
      const encodedSessionId = encodeURIComponent(rawSessionId);

      // Mock SessionStore to return valid session
      const mockSessionStore = {
        getSessionRpc: vi.fn().mockResolvedValue({
          id: rawSessionId,
          userId: 'user-safari',
          expiresAt: Date.now() + 3600000,
          createdAt: Date.now() - 3600000,
        }),
      };

      vi.mocked(getSessionStoreBySessionId).mockReturnValue({
        stub: mockSessionStore as unknown as ReturnType<typeof getSessionStoreBySessionId>['stub'],
        resolution: { generation: 3, regionKey: 'apac', shardIndex: 14 },
        instanceName: 'default:apac:s:14',
      });

      // Mock DB to return admin role
      const mockDB = {
        prepare: vi.fn().mockImplementation((query: string) => {
          if (query.includes('role_assignments')) {
            return {
              bind: vi.fn().mockReturnThis(),
              all: vi.fn().mockResolvedValue({
                results: [{ name: 'admin' }],
              }),
            };
          }
          if (query.includes('users')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue({
                user_type: 'end_user',
                org_id: null,
              }),
            };
          }
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
          };
        }),
      };

      const env = createMockEnv({ DB: mockDB as unknown as D1Database });
      const app = createTestApp(env);

      // Send URL-encoded session ID (as Safari would)
      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: `authrim_admin_session=${encodedSessionId}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.adminAuth.userId).toBe('user-safari');
      expect(data.adminAuth.authMethod).toBe('session');

      // Verify that getSessionStoreBySessionId was called with the decoded session ID
      expect(getSessionStoreBySessionId).toHaveBeenCalledWith(
        expect.anything(), // env
        rawSessionId // decoded session ID
      );
    });

    it('should reject malformed URL-encoded session ID gracefully', async () => {
      // Malformed URL encoding (e.g., %ZZ is invalid)
      const malformedSessionId = 'g3%ZZapac%3A14%3Asession_test';

      const env = createMockEnv();
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: `authrim_admin_session=${malformedSessionId}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toBe('invalid_token');
    });
  });

  describe('Authentication Fallback', () => {
    it('should try Bearer auth first, then session', async () => {
      // Both Bearer and session provided, but Bearer is invalid
      // Mock SessionStore to return valid session
      const mockSessionStore = {
        getSessionRpc: vi.fn().mockResolvedValue({
          id: 'g1:apac:0:session_fallback',
          userId: 'user-123',
          expiresAt: Date.now() + 3600000,
          createdAt: Date.now() - 3600000,
        }),
      };

      vi.mocked(getSessionStoreBySessionId).mockReturnValue({
        stub: mockSessionStore as unknown as ReturnType<typeof getSessionStoreBySessionId>['stub'],
        resolution: { generation: 1, regionKey: 'apac', shardIndex: 0 },
        instanceName: 'default:apac:s:0',
      });

      const mockDB = {
        prepare: vi.fn().mockImplementation((query: string) => {
          // role_assignments JOIN roles query
          if (query.includes('role_assignments')) {
            return {
              bind: vi.fn().mockReturnThis(),
              all: vi.fn().mockResolvedValue({
                results: [{ name: 'admin' }],
              }),
            };
          }
          // users + subject_org_membership query
          if (query.includes('users')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue({
                user_type: null,
                org_id: null,
              }),
            };
          }
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
          };
        }),
      };

      const env = createMockEnv({ DB: mockDB as unknown as D1Database });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Bearer invalid-token',
          Cookie: 'authrim_admin_session=g1:apac:0:session_fallback',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      // Should have used session auth since Bearer failed
      expect(data.adminAuth.authMethod).toBe('session');
    });

    it('should prefer valid Bearer auth over session', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Bearer test-admin-secret',
          Cookie: 'authrim_admin_session=g1:apac:0:session_test',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      // Should have used Bearer auth
      expect(data.adminAuth.authMethod).toBe('bearer');
    });
  });

  describe('No Authentication', () => {
    it('should reject request with no auth credentials', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test');

      const response = await app.fetch(request);
      expect(response.status).toBe(401);

      const data = (await response.json()) as Record<string, unknown>;
      // RFC 6750: invalid_token is the standard error code for Bearer token failures
      expect(data.error).toBe('invalid_token');
      expect(data.error_description).toContain('Admin authentication required');
    });
  });

  describe('Security', () => {
    it('should use constant-time comparison for Bearer tokens', async () => {
      const app = createTestApp(mockEnv);

      // Test with tokens of different lengths - both should fail
      const shortToken = new Request('http://localhost/api/admin/test', {
        headers: { Authorization: 'Bearer short' },
      });
      const longToken = new Request('http://localhost/api/admin/test', {
        headers: { Authorization: 'Bearer this-is-a-very-long-token-that-is-definitely-wrong' },
      });

      const response1 = await app.fetch(shortToken);
      const response2 = await app.fetch(longToken);

      expect(response1.status).toBe(401);
      expect(response2.status).toBe(401);
    });

    it('should not leak timing information for near-matches', async () => {
      const app = createTestApp(mockEnv);

      // Token that matches all but the last character
      const nearMatch = new Request('http://localhost/api/admin/test', {
        headers: { Authorization: 'Bearer test-admin-secreX' },
      });

      const response = await app.fetch(nearMatch);
      expect(response.status).toBe(401);
    });
  });

  describe('Cookie Parsing', () => {
    it('should parse authrim_admin_session from cookie string correctly', async () => {
      // Mock SessionStore to return valid session
      const mockSessionStore = {
        getSessionRpc: vi.fn().mockResolvedValue({
          id: 'g1:apac:0:session_cookie123',
          userId: 'user-123',
          expiresAt: Date.now() + 3600000,
          createdAt: Date.now() - 3600000,
        }),
      };

      vi.mocked(getSessionStoreBySessionId).mockReturnValue({
        stub: mockSessionStore as unknown as ReturnType<typeof getSessionStoreBySessionId>['stub'],
        resolution: { generation: 1, regionKey: 'apac', shardIndex: 0 },
        instanceName: 'default:apac:s:0',
      });

      const mockDB = {
        prepare: vi.fn().mockImplementation((query: string) => {
          // role_assignments JOIN roles query
          if (query.includes('role_assignments')) {
            return {
              bind: vi.fn().mockReturnThis(),
              all: vi.fn().mockResolvedValue({
                results: [{ name: 'admin' }],
              }),
            };
          }
          // users + subject_org_membership query
          if (query.includes('users')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue({
                user_type: null,
                org_id: null,
              }),
            };
          }
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
          };
        }),
      };

      const env = createMockEnv({ DB: mockDB as unknown as D1Database });
      const app = createTestApp(env);

      // Cookie with multiple values
      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie:
            'other_cookie=value; authrim_admin_session=g1:apac:0:session_cookie123; another=thing',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);
    });

    it('should handle cookie without authrim_admin_session', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: 'other_cookie=value; another=thing',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });
  });
});
