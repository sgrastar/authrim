import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { adminAuthMiddleware, requireAdminPermissions, requireMfa } from '../admin-auth';
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
      parent_session_id?: string | null;
      derived_target_tenant_id?: string | null;
    } | null;
    parentSession?: {
      id: string;
      tenant_id: string;
      admin_user_id: string;
      expires_at: number;
      mfa_verified: number;
      parent_session_id?: string | null;
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
    parentSession = null,
    adminUser = null,
    roles = [],
    machinePrincipal = null,
    machineCredential = null,
    machinePrincipalPermissions = [
      { permission: 'admin:tenants.read' },
      { permission: 'admin:clients.create' },
      { permission: 'admin:agent_grants:read' },
      { permission: 'admin:agent_grants:write' },
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
      bind: vi.fn().mockImplementation((...params: unknown[]) => ({
        first: vi.fn().mockImplementation(async () => {
          if (shouldThrow) throw new Error('DB connection failed');
          if (sql.includes('admin_sessions')) {
            if (session?.parent_session_id && params[0] === session.parent_session_id) {
              return parentSession;
            }
            return session;
          }
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
      })),
    })),
  } as unknown as D1Database;
}

/**
 * Create a mock environment for testing
 */
function createMockEnv(overrides: Partial<Env> = {}): Env {
  const adminDb = overrides.DB_ADMIN ?? overrides.DB ?? createMockDB();
  return {
    ISSUER_URL: 'https://test.example.com',
    DB: overrides.DB ?? adminDb,
    DB_ADMIN: adminDb,
    ...overrides,
  } as Env;
}

/**
 * Create a test Hono app with admin auth middleware
 */
function createTestApp(
  env: Env,
  options: Parameters<typeof adminAuthMiddleware>[0] = {},
  contextTenantId?: string
) {
  const app = new Hono<{ Bindings: Env }>();

  if (contextTenantId) {
    app.use('/api/admin/*', async (c, next) => {
      c.set('tenantId', contextTenantId);
      await next();
    });
  }

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

  app.post(`/api/admin/agent-login-handoffs/alh_${'a'.repeat(32)}/approve`, (c) => {
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
    payloadOverrides?: Record<string, unknown>;
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
    ...options.payloadOverrides,
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
    it('accepts a fully verified owner-package bearer context without weakening session-only mode', async () => {
      const authenticateBearer = vi.fn().mockResolvedValue({
        userId: 'admin-user-123',
        actorType: 'agent',
        actorId: 'client:client-1',
        clientId: 'client-1',
        authMethod: 'bearer',
        roles: [],
        tenantId: 'default',
        tenantScope: ['default'],
        permissions: ['admin:users:read'],
        hierarchyLevel: 0,
        mfaVerified: false,
      });
      const app = createTestApp(mockEnv, {
        authenticateBearer,
        requirePermissions: ['admin:users:read'],
      });

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: 'Bearer agent-downscope-token' },
        })
      );

      expect(response.status).toBe(200);
      expect(authenticateBearer).toHaveBeenCalledOnce();
      await expect(response.json()).resolves.toMatchObject({
        adminAuth: { actorType: 'agent', actorId: 'client:client-1' },
      });
    });

    it('rejects an owner-package bearer context without an explicit tenant scope', async () => {
      const authenticateBearer = vi.fn().mockResolvedValue({
        userId: 'admin-user-123',
        actorType: 'agent',
        actorId: 'client:client-1',
        clientId: 'client-1',
        authMethod: 'bearer',
        roles: [],
        tenantId: 'default',
        permissions: ['admin:users:read'],
        hierarchyLevel: 0,
        mfaVerified: false,
      });
      const app = createTestApp(mockEnv, {
        authenticateBearer,
        requirePermissions: ['admin:users:read'],
      });

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: 'Bearer missing-scope-token' },
        })
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' });
    });

    it('reuses an already verified in-process context in nested admin routers', async () => {
      const authenticateBearer = vi.fn().mockResolvedValue({
        userId: 'admin-user-123',
        actorType: 'agent',
        actorId: 'client:client-1',
        authMethod: 'bearer',
        roles: [],
        tenantId: 'default',
        tenantScope: ['default'],
        permissions: ['admin:users:read'],
      });
      const app = new Hono<{ Bindings: Env }>();
      app.use('/api/admin/*', adminAuthMiddleware({ authenticateBearer }));
      app.use('/api/admin/*', adminAuthMiddleware({ requirePermissions: ['admin:users:read'] }));
      app.get('/api/admin/test', (c) => c.json({ ok: true }));

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: 'Bearer agent-downscope-token' },
        }),
        mockEnv
      );

      expect(response.status).toBe(200);
      expect(authenticateBearer).toHaveBeenCalledOnce();
    });

    it('does not allow a machine bearer token to replace the actor in session-only mode', async () => {
      const fixture = await createMachineAccessFixture(['default']);
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
      });
      const env = createMockEnv({
        DB: db,
        PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk),
      });
      const app = createTestApp(env, { sessionOnly: true });

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: `Bearer ${fixture.token}` },
        })
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'invalid_token' });
    });

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
          scope: 'admin:agent_grants:read admin:agent_grants:write',
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
          permissions: ['admin:agent_grants:read', 'admin:agent_grants:write'],
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

    it('should require both the BFF transport credential and an admin session', async () => {
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
        createMockEnv({ DB: db, PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk) })
      );

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            Authorization: `Bearer ${fixture.token}`,
            'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
          },
        })
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error_description: 'Admin UI BFF requests require a valid admin session.',
      });
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

    it.each([
      ['non-machine actor', { actor_type: 'admin' }],
      ['missing actor id', { actor_id: '' }],
      ['missing credential id', { credential_id: '' }],
      ['non-string scope', { scope: ['admin:tenants.read'] }],
    ])('should reject a signed machine token with %s claims', async (_label, payloadOverrides) => {
      const fixture = await createMachineAccessFixture(['default'], { payloadOverrides });
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
      });
      const app = createTestApp(
        createMockEnv({ DB: db, PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk) })
      );

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: `Bearer ${fixture.token}` },
        })
      );

      expect(response.status).toBe(401);
    });

    it.each([
      ['unknown principal', false, true],
      ['unknown credential', true, false],
    ])('should reject a token for an %s', async (_label, includePrincipal, includeCredential) => {
      const fixture = await createMachineAccessFixture(['default']);
      const db = createMockDB({
        machinePrincipal: includePrincipal ? fixture.machinePrincipal : null,
        machineCredential: includeCredential ? fixture.machineCredential : null,
      });
      const app = createTestApp(
        createMockEnv({ DB: db, PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk) })
      );

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: `Bearer ${fixture.token}` },
        })
      );

      expect(response.status).toBe(401);
    });

    it('should reject a credential bound to a different machine principal', async () => {
      const fixture = await createMachineAccessFixture(['default']);
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: { ...fixture.machineCredential, principal_id: 'amp_other' },
      });
      const app = createTestApp(
        createMockEnv({ DB: db, PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk) })
      );

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: `Bearer ${fixture.token}` },
        })
      );

      expect(response.status).toBe(401);
    });

    it('should accept a currently rotating credential with unchanged grants', async () => {
      const fixture = await createMachineAccessFixture(['default'], {
        scope: 'admin:clients.create',
      });
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: { ...fixture.machineCredential, status: 'rotating' },
      });
      const app = createTestApp(
        createMockEnv({ DB: db, PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk) })
      );

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: `Bearer ${fixture.token}` },
        })
      );

      expect(response.status).toBe(200);
    });

    it.each([
      [
        'all principal and credential scopes',
        [{ scope_mode: 'all', tenant_id: null }],
        [{ scope_mode: 'all', tenant_id: null }],
        ['*'],
      ],
      [
        'all principal scope narrowed by credential',
        [{ scope_mode: 'all', tenant_id: null }],
        [{ scope_mode: 'allow', tenant_id: 'default' }],
        ['default'],
      ],
      [
        'tenant principal scope with all credential scope',
        [{ scope_mode: 'allow', tenant_id: 'default' }],
        [{ scope_mode: 'all', tenant_id: null }],
        ['default'],
      ],
    ])('should enforce %s', async (_label, principalScopes, credentialScopes, claimScope) => {
      const fixture = await createMachineAccessFixture(claimScope);
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
        machinePrincipalTenantScopes: principalScopes,
        machineCredentialTenantScopes: credentialScopes,
      });
      const app = createTestApp(
        createMockEnv({ DB: db, PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk) })
      );

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: `Bearer ${fixture.token}` },
        })
      );

      expect(response.status).toBe(200);
    });

    it('should verify a cross-tenant machine token with the platform key manager', async () => {
      const fixture = await createMachineAccessFixture(['tenant-b']);
      const getAllPublicKeysRpc = vi.fn().mockResolvedValue([fixture.publicJwk]);
      const keyManager = {
        idFromName: vi.fn().mockReturnValue('platform-key-manager-id'),
        get: vi.fn().mockReturnValue({ getAllPublicKeysRpc }),
      };
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
        machinePrincipalTenantScopes: [{ scope_mode: 'allow', tenant_id: 'tenant-b' }],
        machineCredentialTenantScopes: [{ scope_mode: 'allow', tenant_id: 'tenant-b' }],
      });
      const app = createTestApp(
        createMockEnv({
          DB: db,
          BASE_DOMAIN: 'example.com',
          DEFAULT_TENANT_ID: 'default',
          KEY_MANAGER: keyManager as unknown as Env['KEY_MANAGER'],
        }),
        {},
        'tenant-b'
      );

      const response = await app.fetch(
        new Request('https://test.example.com/api/admin/test', {
          headers: { Authorization: `Bearer ${fixture.token}` },
        })
      );

      expect(response.status).toBe(200);
      expect(keyManager.idFromName).toHaveBeenCalledWith('default-v3');
      expect(getAllPublicKeysRpc).toHaveBeenCalledOnce();
    });

    it('should reject a token when the key manager has no key matching its kid', async () => {
      const fixture = await createMachineAccessFixture(['default']);
      const keyManager = {
        idFromName: vi.fn().mockReturnValue('tenant-key-manager-id'),
        get: vi.fn().mockReturnValue({ getAllPublicKeysRpc: vi.fn().mockResolvedValue([]) }),
      };
      const app = createTestApp(
        createMockEnv({ KEY_MANAGER: keyManager as unknown as Env['KEY_MANAGER'] })
      );

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: `Bearer ${fixture.token}` },
        })
      );

      expect(response.status).toBe(401);
    });

    it('should reject wildcard tenant claims unless the current grants are also global', async () => {
      const fixture = await createMachineAccessFixture(['*']);
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
        machinePrincipalTenantScopes: [{ scope_mode: 'allow', tenant_id: 'default' }],
      });
      const app = createTestApp(
        createMockEnv({ DB: db, PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk) })
      );

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: `Bearer ${fixture.token}` },
        })
      );

      expect(response.status).toBe(401);
    });

    it('should reject credential permissions that do not intersect principal grants', async () => {
      const fixture = await createMachineAccessFixture(['default'], {
        scope: 'admin:clients.create',
      });
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
        machinePrincipalPermissions: [{ permission: 'admin:tenants.read' }],
        machineCredentialPermissions: [{ permission: 'admin:clients:*' }],
      });
      const app = createTestApp(
        createMockEnv({ DB: db, PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk) })
      );

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: `Bearer ${fixture.token}` },
        })
      );

      expect(response.status).toBe(401);
    });

    it('should ignore a malformed non-array tenant_scope claim without expanding access', async () => {
      const fixture = await createMachineAccessFixture(['default'], {
        payloadOverrides: { tenant_scope: 'default' },
      });
      const db = createMockDB({
        machinePrincipal: fixture.machinePrincipal,
        machineCredential: fixture.machineCredential,
      });
      const app = createTestApp(
        createMockEnv({ DB: db, PUBLIC_JWK_JSON: JSON.stringify(fixture.publicJwk) })
      );

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Authorization: `Bearer ${fixture.token}` },
        })
      );
      const data = (await response.json()) as Record<string, any>;

      expect(response.status).toBe(403);
      expect(data.error).toBe('access_denied');
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

    it('should enforce middleware MFA and permission requirements on a session', async () => {
      const userId = 'admin-user-sensitive-operation';
      const session = { ...createValidSession(userId), mfa_verified: 1 };
      const roles = [
        {
          id: 'role_admin',
          name: 'admin',
          permissions_json: JSON.stringify(['admin:users:*']),
          hierarchy_level: 80,
          inherits_from: null,
        },
      ];
      const db = createMockDB({
        session,
        adminUser: createValidAdminUser(userId),
        roles,
      });
      const app = createTestApp(createMockEnv({ DB: db }), {
        requireMfa: true,
        requirePermissions: ['admin:users:write'],
      });

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Cookie: `authrim_admin_session=${VALID_SESSION_ID}` },
        })
      );

      expect(response.status).toBe(200);
    });

    it('should deny a session that has not satisfied a middleware MFA requirement', async () => {
      const userId = 'admin-user-without-mfa';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });
      const app = createTestApp(createMockEnv({ DB: db }), { requireMfa: true });

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Cookie: `authrim_admin_session=${VALID_SESSION_ID}` },
        })
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: 'mfa_required' });
    });

    it('should ignore malformed, non-array, and cyclic inherited role permissions safely', async () => {
      const userId = 'admin-user-malformed-role';
      const roles = [
        {
          id: 'role_admin',
          name: 'admin',
          permissions_json: JSON.stringify(['admin:users:read', 42]),
          hierarchy_level: 80,
          inherits_from: 'role_malformed',
        },
        {
          id: 'role_malformed',
          name: 'malformed',
          permissions_json: '{bad json',
          hierarchy_level: 70,
          inherits_from: 'role_non_array',
        },
        {
          id: 'role_non_array',
          name: 'non_array',
          permissions_json: JSON.stringify({ permission: 'admin:users:write' }),
          hierarchy_level: 60,
          inherits_from: 'role_admin',
        },
      ];
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles,
      });
      const app = createTestApp(createMockEnv({ DB: db }));

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Cookie: `authrim_admin_session=${VALID_SESSION_ID}` },
        })
      );
      const data = (await response.json()) as Record<string, any>;

      expect(response.status).toBe(200);
      expect(data.adminAuth.permissions).toEqual(['admin:users:read']);
    });

    it('should honor an explicit IP-check exemption for bootstrap routes', async () => {
      const userId = 'admin-user-bootstrap';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
        ipAllowlistEntries: [{ ip_range: '203.0.113.9', ip_version: 4 }],
      });
      const app = createTestApp(createMockEnv({ DB: db }), { skipIpCheck: true });

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Cookie: `authrim_admin_session=${VALID_SESSION_ID}` },
        })
      );

      expect(response.status).toBe(200);
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

    it.each([
      ['exact IPv4', '203.0.113.9', '203.0.113.9', 'CF-Connecting-IP'],
      ['IPv4 CIDR', '203.0.113.0/24', '203.0.113.42', 'CF-Connecting-IP'],
      ['compressed IPv6 CIDR', '2001:db8::/64', '2001:db8::42', 'CF-Connecting-IP'],
      ['first forwarded address', '198.51.100.0/24', '198.51.100.20, 10.0.0.1', 'X-Forwarded-For'],
    ])(
      'should allow a session when the client matches the %s allowlist entry',
      async (_label, ipRange, clientIp, headerName) => {
        const userId = 'admin-user-ip-allowed';
        const db = createMockDB({
          session: createValidSession(userId),
          adminUser: createValidAdminUser(userId),
          roles: createAdminRoles(['admin']),
          ipAllowlistEntries: [{ ip_range: ipRange, ip_version: ipRange.includes(':') ? 6 : 4 }],
        });
        const app = createTestApp(createMockEnv({ DB: db }));

        const response = await app.fetch(
          new Request('http://localhost/api/admin/test', {
            headers: {
              Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
              [headerName]: clientIp,
            },
          })
        );

        expect(response.status).toBe(200);
      }
    );

    it.each([
      ['outside IPv4 CIDR', '203.0.113.0/24', '203.0.114.1'],
      ['IPv4 CIDR prefix above 32', '0.0.0.0/33', '203.0.113.9'],
      ['non-numeric IPv4 suffix', '203.0.113.0/24', '203.0.113.9junk'],
      ['malformed IPv6', '2001:db8::/32', '2001:db8::not-hex'],
      ['IPv6 CIDR prefix above 128', '2001:db8::/129', '2001:db8::1'],
      ['mixed IP versions', '2001:db8::/32', '203.0.113.9'],
    ])(
      'should deny a session for %s instead of weakening the allowlist',
      async (_label, ipRange, clientIp) => {
        const userId = 'admin-user-ip-denied';
        const db = createMockDB({
          session: createValidSession(userId),
          adminUser: createValidAdminUser(userId),
          roles: createAdminRoles(['admin']),
          ipAllowlistEntries: [{ ip_range: ipRange, ip_version: ipRange.includes(':') ? 6 : 4 }],
        });
        const app = createTestApp(createMockEnv({ DB: db }));

        const response = await app.fetch(
          new Request('http://localhost/api/admin/test', {
            headers: {
              Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
              'CF-Connecting-IP': clientIp,
            },
          })
        );
        const data = (await response.json()) as Record<string, unknown>;

        expect(response.status).toBe(403);
        expect(data.error).toBe('access_denied');
      }
    );

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

    it('accepts a derived Admin session only while its parent remains valid', async () => {
      const userId = 'admin-user-derived';
      const parentSessionId = 'admin-session-parent';
      const childSession = {
        ...createValidSession(userId),
        id: 'admin-session-child',
        parent_session_id: parentSessionId,
        derived_target_tenant_id: 'default',
      };
      const db = createMockDB({
        session: childSession,
        parentSession: {
          ...createValidSession(userId),
          id: parentSessionId,
          parent_session_id: null,
        },
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });
      const app = createTestApp(createMockEnv({ DB: db }));

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Cookie: `authrim_admin_session=${childSession.id}` },
        })
      );
      expect(response.status).toBe(200);
    });

    it('binds a derived Admin session to exactly one target tenant issuer', async () => {
      const userId = 'admin-user-derived-target';
      const parentSessionId = 'admin-session-parent-target';
      const childSession = {
        ...createValidSession(userId),
        id: 'admin-session-child-target',
        parent_session_id: parentSessionId,
        derived_target_tenant_id: 'acme',
      };
      const db = createMockDB({
        session: childSession,
        parentSession: {
          ...createValidSession(userId),
          id: parentSessionId,
          parent_session_id: null,
        },
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });
      const app = createTestApp(
        createMockEnv({ DB: db, BASE_DOMAIN: 'authrim.test', DEFAULT_TENANT_ID: 'default' })
      );

      const accepted = await app.fetch(
        new Request('https://acme.authrim.test/api/admin/test', {
          headers: {
            Host: 'acme.authrim.test',
            Cookie: `authrim_admin_session=${childSession.id}`,
          },
        })
      );
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toMatchObject({
        adminAuth: { tenantId: 'acme', tenantScope: ['acme'] },
      });

      const replayedElsewhere = await app.fetch(
        new Request('https://other.authrim.test/api/admin/test', {
          headers: {
            Host: 'other.authrim.test',
            Cookie: `authrim_admin_session=${childSession.id}`,
          },
        })
      );
      expect(replayedElsewhere.status).toBe(401);
    });

    it('rejects a derived Admin session after its parent is revoked', async () => {
      const userId = 'admin-user-derived-revoked';
      const childSession = {
        ...createValidSession(userId),
        id: 'admin-session-child-revoked',
        parent_session_id: 'admin-session-parent-revoked',
        derived_target_tenant_id: 'default',
      };
      const db = createMockDB({
        session: childSession,
        parentSession: null,
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });
      const app = createTestApp(createMockEnv({ DB: db }));

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: { Cookie: `authrim_admin_session=${childSession.id}` },
        })
      );
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

    it('treats only a bounded central login-handoff approval path as platform-scoped', async () => {
      const userId = 'admin-user-handoff';
      const db = createMockDB({
        session: createValidSession(userId),
        adminUser: createValidAdminUser(userId),
        roles: createAdminRoles(['admin']),
      });
      const app = createTestApp(
        createMockEnv({ DB: db, BASE_DOMAIN: 'authrim.test', DEFAULT_TENANT_ID: 'default' })
      );

      const response = await app.fetch(
        new Request(
          `https://admin.example.com/api/admin/agent-login-handoffs/alh_${'a'.repeat(32)}/approve`,
          {
            method: 'POST',
            headers: {
              Host: 'admin.example.com',
              Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
            },
          }
        )
      );
      expect(response.status).toBe(200);

      const malformed = await app.fetch(
        new Request('https://admin.example.com/api/admin/agent-login-handoffs/alh_short/approve', {
          method: 'POST',
          headers: {
            Host: 'admin.example.com',
            Cookie: `authrim_admin_session=${VALID_SESSION_ID}`,
          },
        })
      );
      expect(malformed.status).not.toBe(200);
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

    it('supports an explicit browser login redirect without changing the default API response', async () => {
      const app = createTestApp(mockEnv, {
        unauthenticatedRedirect: (c) =>
          c.req.method === 'GET' ? '/admin/login?return_to=%2Foauth%2Fauthorize' : undefined,
      });

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/admin/login?return_to=%2Foauth%2Fauthorize');
    });

    it('awaits an async browser login redirect builder', async () => {
      const app = createTestApp(mockEnv, {
        unauthenticatedRedirect: async () => {
          await Promise.resolve();
          return '/admin/login?agent_handoff=alh_test';
        },
      });

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/admin/login?agent_handoff=alh_test');
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

describe('admin authorization guards', () => {
  function createGuardApp(
    guard: ReturnType<typeof requireAdminPermissions> | ReturnType<typeof requireMfa>,
    adminAuth?: Record<string, unknown>
  ) {
    const app = new Hono<{ Bindings: Env }>();
    app.use('/guard', async (c, next) => {
      if (adminAuth) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c as any).set('adminAuth', adminAuth);
      }
      await next();
    });
    app.use('/guard', guard);
    app.get('/guard', (c) => c.json({ success: true }));
    return app;
  }

  it('requires an authenticated context before checking permissions', async () => {
    const response = await createGuardApp(requireAdminPermissions(['admin:users:read'])).request(
      '/guard'
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_token' });
  });

  it('denies an authenticated admin missing a required permission', async () => {
    const response = await createGuardApp(requireAdminPermissions(['admin:users:write']), {
      userId: 'admin-1',
      permissions: ['admin:users:read'],
    }).request('/guard');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'insufficient_permissions' });
  });

  it('accepts wildcard permissions only when they cover every required permission', async () => {
    const response = await createGuardApp(
      requireAdminPermissions(['admin:users:read', 'admin:users:write']),
      { userId: 'admin-1', permissions: ['admin:users:*'] }
    ).request('/guard');

    expect(response.status).toBe(200);
  });

  it('requires authentication before evaluating MFA state', async () => {
    const response = await createGuardApp(requireMfa()).request('/guard');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_token' });
  });

  it('denies a valid session that has not completed MFA', async () => {
    const response = await createGuardApp(requireMfa(), {
      userId: 'admin-1',
      mfaVerified: false,
    }).request('/guard');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'mfa_required' });
  });

  it('continues only after MFA has been verified', async () => {
    const response = await createGuardApp(requireMfa(), {
      userId: 'admin-1',
      mfaVerified: true,
    }).request('/guard');

    expect(response.status).toBe(200);
  });
});
