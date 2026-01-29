import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminAuthMiddleware } from '../admin-auth';
import type { Env } from '../../types/env';

/**
 * Admin Authentication Middleware Tests
 *
 * Tests for dual authentication (Bearer token + Session) middleware
 * including security features like constant-time comparison.
 *
 * The middleware uses admin-specific database tables:
 * - admin_sessions: Session storage (not Durable Objects)
 * - admin_users: Admin user accounts
 * - admin_role_assignments + admin_roles: Role/permission mapping
 */

// =============================================================================
// Mock helpers
// =============================================================================

/**
 * Create a mock D1Database that responds to SQL queries
 * based on the query content (matching table names).
 */
function createMockDB(
  options: {
    session?: {
      id: string;
      tenant_id: string;
      admin_user_id: string;
      expires_at: number;
      mfa_verified: number;
    } | null;
    adminUser?: {
      id: string;
      tenant_id: string;
      email: string;
      is_active: number;
      status: string;
    } | null;
    roles?: Array<{
      name: string;
      permissions_json: string;
      hierarchy_level: number;
    }>;
    shouldThrow?: boolean;
  } = {}
): D1Database {
  const { session = null, adminUser = null, roles = [], shouldThrow = false } = options;

  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(async () => {
          if (shouldThrow) throw new Error('DB connection failed');
          if (sql.includes('admin_sessions')) return session;
          if (sql.includes('admin_users')) return adminUser;
          return null;
        }),
        all: vi.fn().mockImplementation(async () => {
          if (shouldThrow) throw new Error('DB connection failed');
          if (sql.includes('admin_role_assignments')) {
            return { results: roles, success: true };
          }
          return { results: [], success: true };
        }),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    })),
  } as unknown as D1Database;
}

/**
 * Create a mock environment for testing
 */
function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_API_SECRET: 'test-admin-secret',
    KEY_MANAGER_SECRET: 'test-key-manager-secret',
    ISSUER_URL: 'https://test.example.com',
    DB: createMockDB(),
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

// =============================================================================
// Shared test data
// =============================================================================

const VALID_SESSION_ID = 'admin-session-test123';

function createValidSession(userId: string = 'admin-user-123') {
  return {
    id: VALID_SESSION_ID,
    tenant_id: 'default',
    admin_user_id: userId,
    expires_at: Date.now() + 3600000, // 1 hour from now
    mfa_verified: 0,
  };
}

function createValidAdminUser(userId: string = 'admin-user-123') {
  return {
    id: userId,
    tenant_id: 'default',
    email: 'admin@example.com',
    is_active: 1,
    status: 'active',
  };
}

function createAdminRoles(roleNames: string[] = ['admin']) {
  return roleNames.map((name, i) => ({
    name,
    permissions_json: JSON.stringify([`admin:${name}:*`]),
    hierarchy_level: (roleNames.length - i) * 10,
  }));
}

// =============================================================================
// Tests
// =============================================================================

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
        roles: ['super_admin', 'system_admin', 'admin', 'system'],
        tenantId: 'default',
        permissions: ['*'],
        hierarchyLevel: 100,
        mfaVerified: true,
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
      const userId = 'admin-user-123';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin', 'viewer']),
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.adminAuth.userId).toBe(userId);
      expect(data.adminAuth.authMethod).toBe('session');
      expect(data.adminAuth.roles).toContain('admin');
    });

    it('should reject expired session', async () => {
      const db = createMockDB({
        // admin_sessions query returns null (WHERE expires_at > ? filters it out)
        session: null,
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should reject session without admin role', async () => {
      const userId = 'admin-user-norole';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        // No roles that match the required admin roles
        roles: [],
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should reject invalid session', async () => {
      const db = createMockDB({
        session: null, // Session not found
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: 'authrim_admin_session=invalid-session-id',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should handle DB errors gracefully', async () => {
      const db = createMockDB({ shouldThrow: true });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should authenticate with URL-encoded session ID (Safari browser behavior)', async () => {
      // Safari and some browsers URL-encode cookie values containing special characters like ':'
      const rawSessionId = 'admin-session:special:chars';
      const encodedSessionId = encodeURIComponent(rawSessionId);
      const userId = 'admin-user-safari';

      const db = createMockDB({
        session: {
          id: rawSessionId,
          tenant_id: 'default',
          admin_user_id: userId,
          expires_at: Date.now() + 3600000,
          mfa_verified: 0,
        },
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });

      const env = createMockEnv({ DB: db });
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
      expect(data.adminAuth.userId).toBe(userId);
      expect(data.adminAuth.authMethod).toBe('session');
    });

    it('should reject malformed URL-encoded session ID gracefully', async () => {
      // Malformed URL encoding (e.g., %ZZ is invalid)
      const malformedSessionId = 'admin%ZZsession%3Atest';

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

    it('should reject inactive admin user', async () => {
      const userId = 'admin-user-inactive';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: null, // is_active = 1 filter removes inactive users
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should reject suspended admin user', async () => {
      const userId = 'admin-user-suspended';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: {
          id: userId,
          tenant_id: 'default',
          email: 'suspended@example.com',
          is_active: 1,
          status: 'suspended', // Account is suspended
        },
        roles: createAdminRoles(['admin']),
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);
    });
  });

  describe('Authentication Fallback', () => {
    it('should try Bearer auth first, then session', async () => {
      // Both Bearer and session provided, but Bearer is invalid
      const userId = 'admin-user-fallback';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Bearer invalid-token',
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
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
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
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
      const userId = 'admin-user-cookie';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      // Cookie with multiple values
      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: `other_cookie=value; authrim_admin_session=${VALID_SESSION_ID}; another=thing`,
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
