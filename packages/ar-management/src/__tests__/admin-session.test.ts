import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockGetCookie,
  mockSetCookie,
  mockBuildIssuerUrl,
  mockGetTenantIdFromContext,
  mockParseAllowedOrigins,
  mockIsAllowedOrigin,
  mockPublishEvent,
  mockScheduleAdminAuthenticationAudit,
  mockGetAdminCookieSameSite,
  mockGetLogger,
  mockLogger,
  mockAdminAdapter,
  mockAdminSessionRepo,
  mockRequireDedicatedAdminDatabaseAdapter,
  MockAdminSessionRepository,
} = vi.hoisted(() => {
  const logger = {
    module: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const adminAdapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
  };

  const adminSessionRepo = {
    getSession: vi.fn(),
    getSessionIncludingExpired: vi.fn(),
    deleteSession: vi.fn(),
  };

  const MockAdminSessionRepository = vi.fn(function MockAdminSessionRepository() {
    return adminSessionRepo;
  });

  return {
    mockGetCookie: vi.fn(),
    mockSetCookie: vi.fn(),
    mockBuildIssuerUrl: vi.fn().mockReturnValue('https://admin.example.com'),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockParseAllowedOrigins: vi.fn().mockReturnValue(['https://admin.example.com']),
    mockIsAllowedOrigin: vi.fn().mockReturnValue(true),
    mockPublishEvent: vi.fn().mockResolvedValue(undefined),
    mockScheduleAdminAuthenticationAudit: vi.fn(),
    mockGetAdminCookieSameSite: vi.fn().mockReturnValue('Lax'),
    mockGetLogger: vi.fn().mockReturnValue(logger),
    mockLogger: logger,
    mockAdminAdapter: adminAdapter,
    mockAdminSessionRepo: adminSessionRepo,
    mockRequireDedicatedAdminDatabaseAdapter: vi.fn().mockReturnValue(adminAdapter),
    MockAdminSessionRepository,
  };
});

vi.mock('hono/cookie', () => ({
  getCookie: mockGetCookie,
  setCookie: mockSetCookie,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    buildIssuerUrl: mockBuildIssuerUrl,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    parseAllowedOrigins: mockParseAllowedOrigins,
    isAllowedOrigin: mockIsAllowedOrigin,
    getLogger: mockGetLogger,
    requireDedicatedAdminDatabaseAdapter: mockRequireDedicatedAdminDatabaseAdapter,
    AdminSessionRepository: MockAdminSessionRepository,
    publishEvent: mockPublishEvent,
    scheduleAdminAuthenticationAudit: mockScheduleAdminAuthenticationAudit,
    getAdminCookieSameSite: mockGetAdminCookieSameSite,
  };
});

import { adminLogoutHandler, adminSessionStatusHandler } from '../admin-session';

function createMockContext(options: {
  headers?: Record<string, string>;
  env?: Partial<Env>;
  adminAuth?: Record<string, unknown>;
}) {
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
    env: {
      ISSUER_URL: 'https://admin.example.com',
      DB_ADMIN: {} as D1Database,
      ...options.env,
    } as Env,
    get: (key: string) => (key === 'adminAuth' ? options.adminAuth : undefined),
    json: vi.fn(
      (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
  } as any;
}

describe('Admin Session Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildIssuerUrl.mockReturnValue('https://admin.example.com');
    mockGetTenantIdFromContext.mockReturnValue('default');
    mockParseAllowedOrigins.mockReturnValue(['https://admin.example.com']);
    mockIsAllowedOrigin.mockReturnValue(true);
    mockPublishEvent.mockResolvedValue(undefined);
    mockGetAdminCookieSameSite.mockReturnValue('Lax');
    mockGetLogger.mockReturnValue(mockLogger);
    mockRequireDedicatedAdminDatabaseAdapter.mockReturnValue(mockAdminAdapter);
  });

  it('returns session details when the admin user has an allowed role', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');
    mockAdminSessionRepo.getSession.mockResolvedValue({
      id: 'admin-session-123',
      tenant_id: 'tenant-a',
      admin_user_id: 'admin-user-1',
      created_at: 100,
      expires_at: 200,
    });
    mockAdminAdapter.query.mockResolvedValue([
      {
        id: 'role-viewer',
        name: 'ar_viewer',
        permissions_json: '["admin:logging:overview:read"]',
        hierarchy_level: 10,
        inherits_from: null,
        scope_type: 'tenant',
        scope_id: null,
      },
    ]);
    mockAdminAdapter.queryOne.mockResolvedValue({
      email: 'admin@example.com',
      name: 'Admin User',
      last_login_at: 1700000000,
      is_active: 1,
      status: 'active',
    });

    const response = await adminSessionStatusHandler(createMockContext({}));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      active: true,
      user_id: 'admin-user-1',
      tenant_id: 'tenant-a',
      email: 'admin@example.com',
      name: 'Admin User',
      roles: ['ar_viewer'],
      permissions: ['admin:logging:overview:read'],
      admin_scope: 'tenant',
      is_platform_admin: false,
      last_login_at: 1700000000,
    });
    expect(body).not.toHaveProperty('session_id');
    expect(mockAdminAdapter.query).toHaveBeenCalledWith(expect.any(String), [
      'admin-user-1',
      'tenant-a',
      'tenant-a',
      'tenant-a',
      expect.any(Number),
    ]);
  });

  it('marks ar_super_admin sessions as platform scoped', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');
    mockAdminSessionRepo.getSession.mockResolvedValue({
      id: 'admin-session-123',
      tenant_id: 'default',
      admin_user_id: 'admin-user-1',
      created_at: 100,
      expires_at: 200,
    });
    mockAdminAdapter.query.mockResolvedValue([
      {
        id: 'role-super-admin',
        name: 'ar_super_admin',
        permissions_json: '["*"]',
        hierarchy_level: 1000,
        inherits_from: null,
        scope_type: 'global',
        scope_id: null,
      },
    ]);
    mockAdminAdapter.queryOne.mockResolvedValue({
      email: 'admin@example.com',
      name: 'Admin User',
      last_login_at: 1700000000,
      is_active: 1,
      status: 'active',
    });

    const response = await adminSessionStatusHandler(createMockContext({}));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      roles: ['ar_super_admin'],
      permissions: ['*'],
      admin_scope: 'platform',
      is_platform_admin: true,
    });
  });

  describe('disabled_capabilities', () => {
    const signedInContext = (options: Parameters<typeof createMockContext>[0]) =>
      createMockContext(options) as unknown as Parameters<typeof adminSessionStatusHandler>[0];

    const capabilityKv = (document: string | null, fail = false) =>
      ({
        get: vi.fn(async (key: string) => {
          if (fail) throw new Error('kv down');
          return key === 'settings:platform:tenant-capabilities' ? document : null;
        }),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      }) as unknown as KVNamespace;

    const signIn = (role: string, scope: 'tenant' | 'global') => {
      mockGetCookie.mockReturnValue('admin-session-123');
      mockAdminSessionRepo.getSession.mockResolvedValue({
        id: 'admin-session-123',
        tenant_id: 'tenant-a',
        admin_user_id: 'admin-user-1',
        created_at: 100,
        expires_at: 200,
      });
      mockAdminAdapter.query.mockResolvedValue([
        {
          id: `role-${role}`,
          name: role,
          permissions_json: '["*"]',
          hierarchy_level: 100,
          inherits_from: null,
          scope_type: scope,
          scope_id: null,
        },
      ]);
      mockAdminAdapter.queryOne.mockResolvedValue({
        email: 'admin@example.com',
        name: 'Admin User',
        last_login_at: 1,
        is_active: 1,
        status: 'active',
      });
    };
    const off = JSON.stringify({
      'tenant_capabilities.webhooks': false,
      'tenant_capabilities.bulk_jobs': false,
      'tenant_capabilities.admin_sent_email': false,
      'tenant_capabilities.machine_credentials': false,
      'tenant_capabilities.email_provider_config': false,
      'tenant_capabilities.directory_connectors': false,
      'tenant_capabilities.external_identity_providers': false,
      'tenant_capabilities.saml_metadata_url': false,
    });
    const tenantAdminAuth = { tenantScope: ['tenant-a'], roles: ['ar_tenant_admin'] };
    const platformAdminAuth = {
      tenantScope: ['*'],
      roles: ['ar_super_admin'],
      globalRoles: ['ar_super_admin'],
    };

    it('lists what the platform turned off for a tenant admin', async () => {
      signIn('ar_tenant_admin', 'tenant');
      const response = await adminSessionStatusHandler(
        signedInContext({
          env: { SETTINGS: capabilityKv(off) },
          adminAuth: tenantAdminAuth,
        })
      );
      await expect(response.json()).resolves.toMatchObject({
        disabled_capabilities: [
          'webhooks',
          'bulk_jobs',
          'admin_sent_email',
          'machine_credentials',
          'email_provider_config',
          'directory_connectors',
          'external_identity_providers',
          'saml_metadata_url',
        ],
      });
    });

    it('is empty when nothing is turned off', async () => {
      signIn('ar_tenant_admin', 'tenant');
      const response = await adminSessionStatusHandler(
        signedInContext({
          env: { SETTINGS: capabilityKv(null) },
          adminAuth: tenantAdminAuth,
        })
      );
      await expect(response.json()).resolves.toMatchObject({ disabled_capabilities: [] });
    });

    it('is empty for a platform admin, who is exempt, without reading the switches', async () => {
      signIn('ar_super_admin', 'global');
      const settings = capabilityKv(off);
      const response = await adminSessionStatusHandler(
        signedInContext({ env: { SETTINGS: settings }, adminAuth: platformAdminAuth })
      );
      await expect(response.json()).resolves.toMatchObject({ disabled_capabilities: [] });
      expect(settings.get).not.toHaveBeenCalled();
    });

    it('is empty (and the session still answers) when the switches cannot be read', async () => {
      signIn('ar_tenant_admin', 'tenant');
      const response = await adminSessionStatusHandler(
        signedInContext({
          env: { SETTINGS: capabilityKv(null, true) },
          adminAuth: tenantAdminAuth,
        })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ disabled_capabilities: [] });
    });
  });

  it('returns effective permissions inherited from parent admin roles', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');
    mockAdminSessionRepo.getSession.mockResolvedValue({
      id: 'admin-session-123',
      tenant_id: 'tenant-a',
      admin_user_id: 'admin-user-1',
      created_at: 100,
      expires_at: 200,
    });
    mockAdminAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'role-child',
          name: 'ar_tenant_admin',
          permissions_json: '["admin:logging:exports:create"]',
          hierarchy_level: 100,
          inherits_from: 'role-parent',
          scope_type: 'tenant',
          scope_id: 'tenant-a',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'role-child',
          name: 'ar_tenant_admin',
          permissions_json: '["admin:logging:exports:create"]',
          hierarchy_level: 100,
          inherits_from: 'role-parent',
        },
        {
          id: 'role-parent',
          name: 'ar_viewer',
          permissions_json: '["admin:logging:overview:read"]',
          hierarchy_level: 10,
          inherits_from: null,
        },
      ]);
    mockAdminAdapter.queryOne.mockResolvedValue({
      email: 'admin@example.com',
      name: 'Admin User',
      last_login_at: 1700000000,
      is_active: 1,
      status: 'active',
    });

    const response = await adminSessionStatusHandler(createMockContext({}));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      roles: ['ar_tenant_admin'],
      permissions: ['admin:logging:exports:create', 'admin:logging:overview:read'],
      admin_scope: 'tenant',
      is_platform_admin: false,
    });
  });

  it('does not mark tenant-scoped ar_super_admin sessions as platform scoped', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');
    mockAdminSessionRepo.getSession.mockResolvedValue({
      id: 'admin-session-123',
      tenant_id: 'tenant-a',
      admin_user_id: 'admin-user-1',
      created_at: 100,
      expires_at: 200,
    });
    mockAdminAdapter.query.mockResolvedValue([
      {
        id: 'role-super-admin',
        name: 'ar_super_admin',
        permissions_json: '["*"]',
        hierarchy_level: 1000,
        inherits_from: null,
        scope_type: 'tenant',
        scope_id: 'tenant-a',
      },
    ]);
    mockAdminAdapter.queryOne.mockResolvedValue({
      email: 'admin@example.com',
      name: 'Admin User',
      last_login_at: 1700000000,
      is_active: 1,
      status: 'active',
    });

    const response = await adminSessionStatusHandler(createMockContext({}));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      roles: ['ar_super_admin'],
      permissions: ['*'],
      admin_scope: 'tenant',
      is_platform_admin: false,
    });
  });

  it('rejects session status requests when the admin account is suspended', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');
    mockAdminSessionRepo.getSession.mockResolvedValue({
      id: 'admin-session-123',
      tenant_id: 'tenant-a',
      admin_user_id: 'admin-user-1',
      created_at: 100,
      expires_at: 200,
    });
    mockAdminAdapter.query.mockResolvedValue([
      {
        id: 'role-viewer',
        name: 'ar_viewer',
        permissions_json: '["admin:logging:overview:read"]',
        hierarchy_level: 10,
        inherits_from: null,
        scope_type: 'tenant',
        scope_id: null,
      },
    ]);
    mockAdminAdapter.queryOne.mockResolvedValue({
      email: 'admin@example.com',
      name: 'Admin User',
      last_login_at: 1700000000,
      is_active: 1,
      status: 'suspended',
    });

    const response = await adminSessionStatusHandler(createMockContext({}));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'session_expired',
      error_description: 'Session has expired or is invalid',
    });
  });

  it('rejects session status requests when the user lacks an admin role', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');
    mockAdminSessionRepo.getSession.mockResolvedValue({
      id: 'admin-session-123',
      tenant_id: 'tenant-a',
      admin_user_id: 'admin-user-1',
      created_at: 100,
      expires_at: 200,
    });
    mockAdminAdapter.query.mockResolvedValue([
      {
        id: 'role-auditor',
        name: 'auditor',
        permissions_json: '["admin:audit:read"]',
        hierarchy_level: 10,
        inherits_from: null,
        scope_type: 'tenant',
        scope_id: null,
      },
    ]);

    const response = await adminSessionStatusHandler(createMockContext({}));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'forbidden',
      error_description: 'You do not have admin permissions',
    });
  });

  it('rejects admin logout when both Origin and Referer are missing', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');

    const response = await adminLogoutHandler(createMockContext({}));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'forbidden',
      error_description: 'Origin or Referer header is required',
    });
    expect(mockSetCookie).not.toHaveBeenCalled();
  });

  it('accepts a valid Referer fallback and clears the admin session cookie', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');
    mockAdminSessionRepo.getSessionIncludingExpired.mockResolvedValue({
      admin_user_id: 'admin-user-1',
    });
    mockAdminSessionRepo.deleteSession.mockResolvedValue(true);

    const response = await adminLogoutHandler(
      createMockContext({
        headers: {
          Referer: 'https://admin.example.com/settings',
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      message: 'Logged out successfully',
    });
    expect(mockIsAllowedOrigin).toHaveBeenCalledWith('https://admin.example.com', [
      'https://admin.example.com',
    ]);
    expect(mockSetCookie).toHaveBeenCalledWith(
      expect.anything(),
      'authrim_admin_session',
      '',
      expect.objectContaining({
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: 0,
      })
    );
    expect(mockPublishEvent).toHaveBeenCalledTimes(2);
    expect(mockScheduleAdminAuthenticationAudit).toHaveBeenCalledTimes(1);
    expect(mockScheduleAdminAuthenticationAudit).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'default',
      action: 'admin.logout',
      adminUserId: 'admin-user-1',
      sessionId: 'admin-session-123',
    });
  });

  it('does not audit a logout that removed no session', async () => {
    mockGetCookie.mockReturnValue('admin-session-123');
    mockAdminSessionRepo.getSessionIncludingExpired.mockResolvedValue({
      admin_user_id: 'admin-user-1',
    });
    mockAdminSessionRepo.deleteSession.mockResolvedValue(false);

    const context = createMockContext({
      headers: { Origin: 'https://admin.example.com' },
    }) as Parameters<typeof adminLogoutHandler>[0];
    const response = await adminLogoutHandler(context);

    expect(response.status).toBe(200);
    expect(mockScheduleAdminAuthenticationAudit).not.toHaveBeenCalled();
  });
});
