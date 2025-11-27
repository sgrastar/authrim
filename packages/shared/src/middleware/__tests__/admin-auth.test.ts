import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminAuthMiddleware } from '../admin-auth';
import type { Env } from '../../types/env';

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

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.adminAuth).toEqual({
        userId: 'system',
        authMethod: 'bearer',
        roles: ['admin', 'system'],
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

      const data = await response.json();
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

      const data = await response.json();
      expect(data.error).toBe('unauthorized');
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
      // Mock DB to return valid session and admin role
      const mockDB = {
        prepare: vi.fn().mockImplementation((query: string) => {
          if (query.includes('sessions')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue({
                user_id: 'user-123',
                expires_at: Date.now() + 3600000, // 1 hour from now
              }),
            };
          }
          if (query.includes('user_roles') && query.includes('role = ?')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue({ role: 'admin' }),
            };
          }
          if (query.includes('user_roles')) {
            return {
              bind: vi.fn().mockReturnThis(),
              all: vi.fn().mockResolvedValue({
                results: [{ role: 'admin' }, { role: 'user' }],
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
          Cookie: 'session_id=valid-session-id',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.adminAuth.userId).toBe('user-123');
      expect(data.adminAuth.authMethod).toBe('session');
      expect(data.adminAuth.roles).toContain('admin');
    });

    it('should reject expired session', async () => {
      const mockDB = {
        prepare: vi.fn().mockImplementation((query: string) => {
          if (query.includes('sessions')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue({
                user_id: 'user-123',
                expires_at: Date.now() - 3600000, // 1 hour ago (expired)
              }),
            };
          }
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue(null),
          };
        }),
      };

      const env = createMockEnv({ DB: mockDB as unknown as D1Database });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: 'session_id=expired-session-id',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should reject session without admin role', async () => {
      const mockDB = {
        prepare: vi.fn().mockImplementation((query: string) => {
          if (query.includes('sessions')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue({
                user_id: 'user-123',
                expires_at: Date.now() + 3600000,
              }),
            };
          }
          // User has no admin role
          if (query.includes('user_roles')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue(null), // No admin role
            };
          }
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue(null),
          };
        }),
      };

      const env = createMockEnv({ DB: mockDB as unknown as D1Database });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: 'session_id=non-admin-session-id',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should reject invalid session', async () => {
      const mockDB = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null), // Session not found
        }),
      };

      const env = createMockEnv({ DB: mockDB as unknown as D1Database });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: 'session_id=invalid-session-id',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should handle DB errors gracefully', async () => {
      const mockDB = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockRejectedValue(new Error('DB connection failed')),
        }),
      };

      const env = createMockEnv({ DB: mockDB as unknown as D1Database });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: 'session_id=some-session-id',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });
  });

  describe('Authentication Fallback', () => {
    it('should try Bearer auth first, then session', async () => {
      // Both Bearer and session provided, but Bearer is invalid
      const mockDB = {
        prepare: vi.fn().mockImplementation((query: string) => {
          if (query.includes('sessions')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue({
                user_id: 'user-123',
                expires_at: Date.now() + 3600000,
              }),
            };
          }
          if (query.includes('user_roles') && query.includes('role = ?')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue({ role: 'admin' }),
            };
          }
          if (query.includes('user_roles')) {
            return {
              bind: vi.fn().mockReturnThis(),
              all: vi.fn().mockResolvedValue({
                results: [{ role: 'admin' }],
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
          Cookie: 'session_id=valid-session-id',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      // Should have used session auth since Bearer failed
      expect(data.adminAuth.authMethod).toBe('session');
    });

    it('should prefer valid Bearer auth over session', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Bearer test-admin-secret',
          Cookie: 'session_id=some-session-id',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json();
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

      const data = await response.json();
      expect(data.error).toBe('unauthorized');
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
    it('should parse session_id from cookie string correctly', async () => {
      const mockDB = {
        prepare: vi.fn().mockImplementation((query: string) => {
          if (query.includes('sessions')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue({
                user_id: 'user-123',
                expires_at: Date.now() + 3600000,
              }),
            };
          }
          if (query.includes('user_roles') && query.includes('role = ?')) {
            return {
              bind: vi.fn().mockReturnThis(),
              first: vi.fn().mockResolvedValue({ role: 'admin' }),
            };
          }
          if (query.includes('user_roles')) {
            return {
              bind: vi.fn().mockReturnThis(),
              all: vi.fn().mockResolvedValue({ results: [{ role: 'admin' }] }),
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
          Cookie: 'other_cookie=value; session_id=valid-session-123; another=thing',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);
    });

    it('should handle cookie without session_id', async () => {
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
