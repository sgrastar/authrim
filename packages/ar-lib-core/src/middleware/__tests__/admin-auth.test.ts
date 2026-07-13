import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { adminAuthMiddleware } from '../admin-auth';
import type { Env } from '../../types/env';

/**
 * Admin Authentication Middleware Tests
 *
 * Tests for Admin UI session authentication middleware and static root bearer
 * secret rejection.
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
      id?: string;
      name: string;
      permissions_json: string;
      hierarchy_level: number;
      inherits_from?: string | null;
    }>;
    machinePrincipal?: Record<string, unknown> | null;
    machineCredential?: Record<string, unknown> | null;
    machinePrincipalPermissions?: Array<{ permission: string }>;
    machineCredentialPermissions?: Array<{ permission: string }>;
    machinePrincipalTenantScopes?: Array<{ scope_mode: string; tenant_id: string | null }>;
    machineCredentialTenantScopes?: Array<{ scope_mode: string; tenant_id: string | null }>;
    ipAllowlistEntries?: Array<{ ip_range: string; ip_version: number }>;
    throwOnIpAllowlist?: boolean;
    shouldThrow?: boolean;
  } = {}
): D1Database {
  const {
    session = null,
    adminUser = null,
    roles = [],
    machinePrincipal = null,
    machineCredential = null,
    machinePrincipalPermissions = [
      { permission: 'admin:tenants.read' },
      { permission: 'admin:clients.create' },
      { permission: 'admin:ai_grants:read' },
      { permission: 'admin:ai_grants:create' },
    ],
    machineCredentialPermissions = [],
    machinePrincipalTenantScopes = [{ scope_mode: 'allow', tenant_id: 'default' }],
    machineCredentialTenantScopes = [],
    ipAllowlistEntries = [],
    throwOnIpAllowlist = false,
    shouldThrow = false,
  } = options;

  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(async () => {
          if (shouldThrow) throw new Error('DB connection failed');
          if (sql.includes('admin_sessions')) return session;
          if (sql.includes('admin_users')) return adminUser;
          if (sql.includes('admin_machine_principals')) return machinePrincipal;
          if (sql.includes('admin_machine_credentials')) return machineCredential;
          return null;
        }),
        all: vi.fn().mockImplementation(async () => {
          if (shouldThrow) throw new Error('DB connection failed');
          if (sql.includes('admin_ip_allowlist')) {
            if (throwOnIpAllowlist) throw new Error('IP allowlist query failed');
            return { results: ipAllowlistEntries, success: true };
          }
          if (sql.includes('admin_role_assignments')) {
            return { results: roles, success: true };
          }
          if (sql.includes('admin_roles')) {
            return { results: roles, success: true };
          }
          if (sql.includes('admin_machine_principal_permissions')) {
            return { results: machinePrincipalPermissions, success: true };
          }
          if (sql.includes('admin_machine_credential_permissions')) {
            return { results: machineCredentialPermissions, success: true };
          }
          if (sql.includes('admin_machine_principal_tenant_scopes')) {
            return { results: machinePrincipalTenantScopes, success: true };
          }
          if (sql.includes('admin_machine_credential_tenant_scopes')) {
            return { results: machineCredentialTenantScopes, success: true };
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
    ISSUER_URL: 'https://test.example.com',
    DB: createMockDB(),
    ...overrides,
  } as Env;
}

/**
 * Create a test Hono app with admin auth middleware
 */
function createTestApp(env: Env, options: Parameters<typeof adminAuthMiddleware>[0] = {}) {
  const app = new Hono<{ Bindings: Env }>();

  // Apply admin auth middleware
  app.use('/api/admin/*', adminAuthMiddleware(options));

  // Protected test endpoint
  app.get('/api/admin/test', (c) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAuth = (c as any).get('adminAuth');
    return c.json({ success: true, adminAuth });
  });

  app.get('/api/admin/me/session', (c) => {
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

function createAdminRoles(roleNames: string[] = ['admin'], hasGlobalScope: boolean = false) {
  return roleNames.map((name, i) => ({
    id: `role_${name}`,
    name,
    permissions_json: JSON.stringify([`admin:${name}:*`]),
    hierarchy_level: (roleNames.length - i) * 10,
    inherits_from: null,
    has_global_scope: hasGlobalScope ? 1 : 0,
  }));
}

async function createMachineAccessFixture(
  tenantScope: string[] = ['default'],
  options: {
    principalType?: 'setup_tool' | 'admin_ui_bff' | 'mcp_server' | 'ai_agent';
    principalId?: string;
    clientId?: string;
    credentialId?: string;
    scope?: string;
    displayName?: string;
  } = {}
) {
  const principalType = options.principalType ?? 'setup_tool';
  const principalId = options.principalId ?? 'amp_setup';
  const clientId = options.clientId ?? 'setup-tool';
  const credentialId = options.credentialId ?? 'amk_setup';
  const scope = options.scope ?? 'admin:tenants.read admin:clients.create';
  const displayName =
    options.displayName ??
    (principalType === 'admin_ui_bff' ? 'Admin UI BFF' : 'Authrim Setup Tool');
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'admin-token-key';
  publicJwk.alg = 'RS256';

  const token = await new SignJWT({
    sub: `machine:${principalId}`,
    aud: 'authrim:admin-api',
    azp: clientId,
    client_id: clientId,
    actor_type: 'machine',
    actor_id: principalId,
    credential_id: credentialId,
    client_auth_method: 'private_key_jwt',
    credential_strength: 'asymmetric_key',
    sender_constrained: false,
    scope,
    tenant_scope: tenantScope,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'admin-token-key' })
    .setIssuer('https://test.example.com')
    .setIssuedAt()
    .setExpirationTime('10m')
    .setJti('admin-machine-token-1')
    .sign(privateKey);

  return {
    token,
    publicJwk,
    machinePrincipal: {
      id: principalId,
      client_id: clientId,
      display_name: displayName,
      description: null,
      principal_type: principalType,
      status: 'active',
      default_audience: 'authrim:admin-api',
      token_ttl_seconds: 600,
      created_by_actor_type: 'bootstrap',
      created_by_actor_id: 'setup',
      created_at: 1,
      updated_at: 1,
      disabled_at: null,
      disabled_by_actor_type: null,
      disabled_by_actor_id: null,
    },
    machineCredential: {
      id: credentialId,
      principal_id: principalId,
      kid: 'setup-2026-05',
      public_jwk_json: '{"kty":"EC"}',
      alg: 'ES256',
      display_name: 'Setup key',
      description: null,
      status: 'active',
      not_before: null,
      expires_at: null,
      last_used_at: null,
      last_used_ip: null,
      last_used_user_agent: null,
      created_by_actor_type: 'bootstrap',
      created_by_actor_id: 'setup',
      created_at: 1,
      updated_at: 1,
      revoked_at: null,
      revoked_by_actor_type: null,
      revoked_by_actor_id: null,
      revoke_reason: null,
    },
  };
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
    it('should reject a legacy unscoped static bearer token', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Bearer test-admin-secret',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toBe('invalid_token');
    });

    it('should reject an internal component secret as Admin API authentication', async () => {
      const env = createMockEnv();
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Bearer test-key-manager-secret',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(401);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toBe('invalid_token');
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

    it('should reject arbitrary bearer tokens when no machine credential matches', async () => {
      const env = createMockEnv();
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

    it('should authenticate scoped Admin machine access tokens', async () => {
      const fixture = await createMachineAccessFixture(['default']);
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
      });
      const env = createMockEnv({
        DB: db,
        PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk),
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: `Bearer ${fixture.token}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, any>;
      expect(data.adminAuth).toMatchObject({
        userId: 'amp_setup',
        actorType: 'machine',
        actorId: 'amp_setup',
        credentialId: 'amk_setup',
        authMethod: 'machine_access_token',
        tenantId: 'default',
        roles: [],
        permissions: ['admin:tenants.read', 'admin:clients.create'],
        clientAuthMethod: 'private_key_jwt',
        credentialStrength: 'asymmetric_key',
        senderConstrained: false,
        tenantScope: ['default'],
      });
    });

    it('should reject Admin machine access tokens after permission grants are removed', async () => {
      const fixture = await createMachineAccessFixture(['default']);
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
        machinePrincipalPermissions: [{ permission: 'admin:tenants.read' }],
      });
      const env = createMockEnv({
        DB: db,
        PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            Authorization: `Bearer ${fixture.token}`,
          },
        })
      );

      expect(response.status).toBe(401);
    });

    it('should reject Admin machine access tokens after tenant grants are removed', async () => {
      const fixture = await createMachineAccessFixture(['default']);
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
        machinePrincipalTenantScopes: [{ scope_mode: 'none', tenant_id: null }],
      });
      const env = createMockEnv({
        DB: db,
        PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            Authorization: `Bearer ${fixture.token}`,
          },
        })
      );

      expect(response.status).toBe(401);
    });

    it('should authenticate MCP and AI agent machine principals as primary Admin API actors', async () => {
      for (const principalType of ['mcp_server', 'ai_agent'] as const) {
        const fixture = await createMachineAccessFixture(['default'], {
          principalType,
          principalId: `amp_${principalType}`,
          clientId: `${principalType}-admin`,
          credentialId: `amk_${principalType}`,
          scope: 'admin:ai_grants:read admin:ai_grants:create',
          displayName: `${principalType} Admin`,
        });
        const db = createMockDB({
          machinePrincipal: fixture.machinePrincipal,
          machineCredential: fixture.machineCredential,
        });
        const env = createMockEnv({
          DB: db,
          PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk),
        });
        const app = createTestApp(env);

        const response = await app.fetch(
          new Request('http://localhost/api/admin/test', {
            headers: {
              Authorization: `Bearer ${fixture.token}`,
            },
          })
        );

        expect(response.status).toBe(200);
        const data = (await response.json()) as Record<string, any>;
        expect(data.adminAuth).toMatchObject({
          userId: `amp_${principalType}`,
          actorType: 'machine',
          actorId: `amp_${principalType}`,
          principalType,
          credentialId: `amk_${principalType}`,
          authMethod: 'machine_access_token',
          permissions: ['admin:ai_grants:read', 'admin:ai_grants:create'],
        });
      }
    });

    it('should attach Admin UI BFF machine token as transport auth while keeping session as actor', async () => {
      const fixture = await createMachineAccessFixture(['default'], {
        principalType: 'admin_ui_bff',
        principalId: 'amp_admin_ui_bff',
        clientId: 'admin-ui-bff',
        credentialId: 'amk_admin_ui_bff',
      });
      const db = createMockDB({
        session: createValidSession(),
        adminUser: createValidAdminUser(),
        roles: createAdminRoles(['admin']),
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
      });
      const env = createMockEnv({
        DB: db,
        PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk),
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          Cookie: `${VALID_SESSION_ID}=ignored; authrim_admin_session=${VALID_SESSION_ID}`,
          'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, any>;
      expect(data.adminAuth).toMatchObject({
        userId: 'admin-user-123',
        authMethod: 'session',
        roles: ['admin'],
        tenantId: 'default',
        transportAuth: {
          authMethod: 'machine_access_token',
          actorType: 'machine',
          actorId: 'amp_admin_ui_bff',
          principalType: 'admin_ui_bff',
          credentialId: 'amk_admin_ui_bff',
          clientId: 'admin-ui-bff',
          clientAuthMethod: 'private_key_jwt',
        },
      });
    });

    it('should reject Admin UI BFF transport requests without a machine token', async () => {
      const db = createMockDB({
        session: createValidSession(),
        adminUser: createValidAdminUser(),
        roles: createAdminRoles(['admin']),
      });
      const app = createTestApp(createMockEnv({ DB: db }));

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
          'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
        },
      });

      const response = await app.fetch(request);
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(401);
      expect(data.error).toBe('invalid_token');
    });

    it('should reject non-BFF machine credentials as Admin UI BFF transport auth', async () => {
      const fixture = await createMachineAccessFixture(['default']);
      const db = createMockDB({
        session: createValidSession(),
        adminUser: createValidAdminUser(),
        roles: createAdminRoles(['admin']),
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
      });
      const app = createTestApp(
        createMockEnv({
          DB: db,
          PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk),
        })
      );

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
          'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
        },
      });

      const response = await app.fetch(request);
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(403);
      expect(data.error).toBe('access_denied');
    });

    it('should reject Admin UI BFF credentials as primary Admin API auth', async () => {
      const fixture = await createMachineAccessFixture(['default'], {
        principalType: 'admin_ui_bff',
        principalId: 'amp_admin_ui_bff',
        clientId: 'admin-ui-bff',
        credentialId: 'amk_admin_ui_bff',
      });
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
      });
      const app = createTestApp(
        createMockEnv({
          DB: db,
          PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk),
        })
      );

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: `Bearer ${fixture.token}`,
        },
      });

      const response = await app.fetch(request);
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(401);
      expect(data.error).toBe('invalid_token');
    });

    it('should reject Admin machine tokens outside their tenant scope', async () => {
      const fixture = await createMachineAccessFixture(['other']);
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
        machinePrincipalTenantScopes: [{ scope_mode: 'allow', tenant_id: 'other' }],
      });
      const env = createMockEnv({
        DB: db,
        PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk),
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: `Bearer ${fixture.token}`,
        },
      });

      const response = await app.fetch(request);
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(403);
      expect(data.error).toBe('access_denied');
    });

    it('should reject Admin machine tokens for disabled principals', async () => {
      const fixture = await createMachineAccessFixture(['default']);
      const db = createMockDB({
        machinePrincipal: {
          ...fixture.machinePrincipal,
          status: 'disabled',
        },
        machineCredential: fixture.machineCredential,
      });
      const env = createMockEnv({
        DB: db,
        PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            Authorization: `Bearer ${fixture.token}`,
          },
        })
      );

      expect(response.status).toBe(401);
    });

    it('should reject Admin machine tokens for revoked credentials', async () => {
      const fixture = await createMachineAccessFixture(['default']);
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: {
          ...fixture.machineCredential,
          status: 'revoked',
        },
      });
      const env = createMockEnv({
        DB: db,
        PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            Authorization: `Bearer ${fixture.token}`,
          },
        })
      );

      expect(response.status).toBe(401);
    });

    it('should enforce endpoint permissions against Admin machine token scopes', async () => {
      const fixture = await createMachineAccessFixture(['default']);
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
      });
      const env = createMockEnv({
        DB: db,
        PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk),
      });
      const app = createTestApp(env, {
        requirePermissions: ['admin:keys.rotate'],
      });

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            Authorization: `Bearer ${fixture.token}`,
          },
        })
      );
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(403);
      expect(data.error).toBe('insufficient_permissions');
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

    it('should allow sessions without a client IP when no IP allowlist entries exist', async () => {
      const userId = 'admin-user-123';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
        ipAllowlistEntries: [],
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
          },
        })
      );

      expect(response.status).toBe(200);
    });

    it('should reject sessions without a client IP when an IP allowlist is active', async () => {
      const userId = 'admin-user-123';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
        ipAllowlistEntries: [{ ip_range: '203.0.113.9', ip_version: 4 }],
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
          },
        })
      );
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(403);
      expect(data.error).toBe('access_denied');
    });

    it('should reject sessions when the active IP allowlist check fails', async () => {
      const userId = 'admin-user-123';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
        throwOnIpAllowlist: true,
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
            'CF-Connecting-IP': '203.0.113.9',
          },
        })
      );
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(403);
      expect(data.error).toBe('access_denied');
    });

    it('should reject X-Session-Id without the HttpOnly admin session cookie', async () => {
      const db = createMockDB({
        session: createValidSession('admin-user-123'),
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          'X-Session-Id': VALID_SESSION_ID,
        },
      });

      const response = await app.fetch(request);

      expect(response.status).toBe(401);
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('should constrain admin user, role, and session update by session tenant', async () => {
      const userId = 'admin-user-tenant-scoped';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
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
      expect(response.status).toBe(200);
      expect(db.prepare).toHaveBeenCalledWith(
        'SELECT * FROM admin_users WHERE id = ? AND tenant_id = ? AND is_active = 1'
      );
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('AND ra.tenant_id = ?'));
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("OR (r.tenant_id = 'default' AND r.is_system = 1)")
      );
      expect(db.prepare).toHaveBeenCalledWith(
        'UPDATE admin_sessions SET last_activity_at = ? WHERE id = ? AND tenant_id = ?'
      );
    });

    it('should include inherited admin role permissions in the session auth context', async () => {
      const userId = 'admin-user-inherited';
      const roles = [
        {
          id: 'role_child_admin',
          name: 'admin',
          permissions_json: JSON.stringify(['admin:users:read']),
          hierarchy_level: 80,
          inherits_from: 'role_parent_storage',
        },
        {
          id: 'role_parent_storage',
          name: 'storage_destination_viewer',
          permissions_json: JSON.stringify(['admin:storage_destinations:read']),
          hierarchy_level: 32,
          inherits_from: null,
        },
      ];
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles,
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

      const data = (await response.json()) as Record<string, any>;
      expect(data.adminAuth.permissions).toContain('admin:users:read');
      expect(data.adminAuth.permissions).toContain('admin:storage_destinations:read');
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

    it('should reject cross-tenant sessions on tenant admin routes', async () => {
      const userId = 'admin-user-cross-tenant';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });

      const env = createMockEnv({
        DB: db,
        BASE_DOMAIN: 'authrim.test',
        DEFAULT_TENANT_ID: 'default',
      });
      const app = createTestApp(env);

      const request = new Request('https://acme.authrim.test/api/admin/test', {
        headers: {
          Host: 'acme.authrim.test',
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(403);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toBe('access_denied');
    });

    it('should allow global scoped session roles across tenant admin routes', async () => {
      const userId = 'admin-user-global-scope';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin'], true),
      });

      const env = createMockEnv({
        DB: db,
        BASE_DOMAIN: 'authrim.test',
        DEFAULT_TENANT_ID: 'default',
      });
      const app = createTestApp(env);

      const request = new Request('https://acme.authrim.test/api/admin/test', {
        headers: {
          Host: 'acme.authrim.test',
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        adminAuth?: { tenantId?: string; tenantScope?: string[] };
      };
      expect(data.adminAuth?.tenantId).toBe('acme');
      expect(data.adminAuth?.tenantScope).toEqual(['*']);
    });

    it('should reject tenant routes when request tenant cannot be resolved', async () => {
      const userId = 'admin-user-unresolved-tenant';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });

      const env = createMockEnv({
        DB: db,
        BASE_DOMAIN: 'authrim.test',
        DEFAULT_TENANT_ID: 'default',
      });
      const app = createTestApp(env);

      const request = new Request('https://unknown.example.com/api/admin/test', {
        headers: {
          Host: 'unknown.example.com',
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(400);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toBe('invalid_request');
    });

    it('should allow session status without a resolved tenant in multi-tenant mode', async () => {
      const userId = 'admin-user-session-status';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });

      const env = createMockEnv({
        DB: db,
        BASE_DOMAIN: 'authrim.test',
        DEFAULT_TENANT_ID: 'default',
      });
      const app = createTestApp(env);

      const request = new Request('https://unknown.example.com/api/admin/me/session', {
        headers: {
          Host: 'unknown.example.com',
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);
    });

    it('should allow session tenant mismatch on platform admin routes', async () => {
      const userId = 'admin-user-platform';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });

      const env = createMockEnv({
        DB: db,
        BASE_DOMAIN: 'authrim.test',
        DEFAULT_TENANT_ID: 'default',
      });
      const app = createTestApp(env, { plane: 'platform' });

      const request = new Request('https://acme.authrim.test/api/admin/test', {
        headers: {
          Host: 'acme.authrim.test',
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);
    });
  });

  describe('Authentication Fallback', () => {
    it('should ignore invalid Bearer auth when a valid session is present', async () => {
      // Both Bearer and session provided, but Bearer is not an accepted auth source.
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
      expect(data.adminAuth.authMethod).toBe('session');
    });

    it('should prefer a valid session over an invalid bearer token', async () => {
      const userId = 'admin-user-session-wins';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });

      const env = createMockEnv({ DB: db });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          Authorization: 'Bearer test-admin-secret',
          Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
        },
      });

      const response = await app.fetch(request);
      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.adminAuth.authMethod).toBe('session');
      expect(data.adminAuth.userId).toBe(userId);
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
    it('should reject Bearer tokens of different lengths', async () => {
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

    it('should reject near-matches for removed static bearer secrets', async () => {
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
