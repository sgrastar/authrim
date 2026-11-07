import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const { adapter, notifier, repo, audit, gate } = vi.hoisted(() => ({
  gate: vi.fn(async (): Promise<Response | null> => null),
  adapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rowsAffected: number }>>(),
    batch:
      vi.fn<
        (
          statements: Array<{ sql: string; params?: unknown[] }>
        ) => Promise<Array<{ rowsAffected: number }>>
      >(),
  },
  notifier: {
    send: vi.fn<(input: { body: string }) => Promise<{ success: boolean; error?: string }>>(),
  },
  repo: {
    findByEmail: vi.fn(),
    getRole: vi.fn(),
  },
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => adapter),
    AdminUserRepository: class {
      findByEmail = repo.findByEmail;
    },
    AdminRoleRepository: class {
      getRole = repo.getRole;
    },
    getRequiredPluginContext: vi.fn(() => ({
      registry: { getNotifier: () => notifier },
    })),
    produceNotificationDelivery: vi.fn(async (_env, input) => {
      const result = await notifier.send(input.payload);
      return {
        reference: { intentId: input.intentId },
        bindingRef: 'PLATFORM_NOTIFICATION_DB',
        delivery: result.success ? 'delivered' : 'permanent_failure',
      };
    }),
    adminAuthMiddleware:
      () =>
      async (
        c: {
          req: { header: (name: string) => string | undefined };
          set: (key: string, value: unknown) => void;
        },
        next: () => Promise<void>
      ) => {
        c.set('adminAuth', {
          userId: 'admin_actor',
          email: 'actor@example.com',
          permissions: (c.req.header('x-test-permissions') ?? '').split(',').filter(Boolean),
          globalPermissions: (c.req.header('x-test-global-permissions') ?? '')
            .split(',')
            .filter(Boolean),
          tenantScope: (c.req.header('x-test-tenant-scope') ?? '').split(',').filter(Boolean),
          roles: ['admin'],
          hierarchyLevel: Number(c.req.header('x-test-hierarchy-level') ?? '100'),
        });
        c.set('tenantId', 'tenant_123');
        await next();
      },
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
  };
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: audit }));
vi.mock('../admin-step-up-gate', () => ({ requireAdminStepUp: gate }));

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { adminInvitationsRouter } from '../routes/admin-management/admin-invitations';

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/admin-invitations', adminInvitationsRouter);
  return {
    app,
    env: {
      DB_ADMIN: {},
      DEFAULT_TENANT_ID: 'tenant_123',
      ADMIN_UI_URL: 'https://admin.example.com',
      EMAIL_FROM: 'security@example.com',
    } as unknown as Env,
  };
}

function invitationPermissions(extra: string[] = []): string {
  return [
    ADMIN_PERMISSIONS.ADMIN_USERS_READ,
    ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
    ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
    ...extra,
  ].join(',');
}

function getInvitationInsertParams(): unknown[] | undefined {
  return adapter.execute.mock.calls.find(([sql]) =>
    sql.includes('INSERT INTO admin_invitations')
  )?.[1];
}

describe('adminInvitationsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.mockReset();
    gate.mockResolvedValue(null);
    repo.findByEmail.mockResolvedValue(null);
    repo.getRole.mockResolvedValue({
      id: 'role_ar_tenant_admin',
      tenant_id: 'tenant_123',
      name: 'ar_tenant_admin',
      display_name: 'Administrator',
      hierarchy_level: 10,
      is_system: false,
    });
    adapter.queryOne.mockResolvedValue(null);
    // No admin groups named by default
    adapter.query.mockResolvedValue([]);
    adapter.execute.mockResolvedValue({ rowsAffected: 1 });
    adapter.batch.mockResolvedValue([{ rowsAffected: 1 }, { rowsAffected: 0 }]);
    notifier.send.mockResolvedValue({ success: true });
    audit.mockResolvedValue(undefined);
  });

  it('creates a code-only invitation with IP restriction disabled by default', async () => {
    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': invitationPermissions(),
        },
        body: JSON.stringify({
          email: 'NEW@EXAMPLE.COM',
          role_id: 'role_ar_tenant_admin',
          allowed_ip_ranges: ['203.0.113.0/24'],
        }),
      },
      env
    );
    const body: unknown = await response.json();
    const insertParams = getInvitationInsertParams();
    const insertSql = adapter.execute.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO admin_invitations')
    )?.[0];

    expect(response.status).toBe(201);
    expect(body).not.toHaveProperty('code');
    expect(insertParams?.[3]).toBe('new@example.com');
    expect(insertParams?.[10]).toBe(0);
    expect(insertParams?.[11]).toBe('[]');
    expect(insertParams?.[17]).toBe('new@example.com');
    expect(insertParams?.[18]).toBe('ar_tenant_admin');
    expect(insertParams?.[19]).toBe('Administrator');
    expect(insertSql?.match(/\?/gu) ?? []).toHaveLength(insertParams?.length ?? 0);
    expect(notifier.send).toHaveBeenCalledOnce();
    const email = notifier.send.mock.calls[0][0];
    expect(email.body).toContain('<code>https://admin.example.com/admin/join</code>');
    expect(email.body).not.toContain('<a ');
  });

  it('accepts up to five single, CIDR, and explicit IP ranges', async () => {
    const ranges = [
      '203.0.113.10',
      '203.0.113.0/24',
      '203.0.113.20-203.0.113.30',
      '2001:db8::/64',
      '2001:db8::1-2001:db8::ffff',
    ];
    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': invitationPermissions(),
        },
        body: JSON.stringify({
          email: 'admin@example.com',
          role_id: 'role_ar_tenant_admin',
          ip_restriction_enabled: true,
          allowed_ip_ranges: ranges,
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    const insertParams = getInvitationInsertParams();
    expect(insertParams?.[10]).toBe(1);
    expect(JSON.parse(String(insertParams?.[11]))).toEqual(ranges);
  });

  it('rejects more than five IP entries without persisting an invitation', async () => {
    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': invitationPermissions(),
        },
        body: JSON.stringify({
          email: 'admin@example.com',
          role_id: 'role_ar_tenant_admin',
          ip_restriction_enabled: true,
          allowed_ip_ranges: Array.from({ length: 6 }, (_, index) => `203.0.113.${index + 1}`),
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('rejects invalid runtime field types before database writes', async () => {
    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': invitationPermissions(),
        },
        body: JSON.stringify({
          email: 'admin@example.com',
          role_id: 'role_ar_tenant_admin',
          name: { unexpected: true },
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('allows a wildcard-authorized Admin to invite a peer ar_super_admin globally', async () => {
    repo.getRole.mockResolvedValue({
      id: 'role_ar_super_admin',
      tenant_id: 'default',
      name: 'ar_super_admin',
      display_name: 'Super Admin',
      hierarchy_level: 0,
      is_system: true,
    });
    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': invitationPermissions(['*']),
          'x-test-global-permissions': '*',
          'x-test-tenant-scope': '*',
          'x-test-hierarchy-level': '0',
        },
        body: JSON.stringify({ email: 'peer@example.com', role_id: 'role_ar_super_admin' }),
      },
      env
    );

    expect(response.status).toBe(201);
    const insertParams = getInvitationInsertParams();
    expect(insertParams?.[7]).toBe('global');
    expect(insertParams?.[8]).toBeNull();
  });

  it('refuses a global invitation from a tenant that is not the deployment default', async () => {
    repo.getRole.mockResolvedValue({
      id: 'role_ar_super_admin',
      tenant_id: 'default',
      name: 'ar_super_admin',
      display_name: 'Super Admin',
      hierarchy_level: 0,
      is_system: true,
    });
    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': invitationPermissions(['*']),
          'x-test-global-permissions': '*',
          'x-test-tenant-scope': '*',
          'x-test-hierarchy-level': '0',
        },
        body: JSON.stringify({ email: 'peer@example.com', role_id: 'role_ar_super_admin' }),
      },
      { ...env, DEFAULT_TENANT_ID: 'platform' }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'cross_tenant_admin_requires_default_home',
    });
    expect(getInvitationInsertParams()).toBeUndefined();
  });

  it.each([
    [
      'a wildcard that is not a global one',
      { 'x-test-global-permissions': '', 'x-test-tenant-scope': '*' },
    ],
    [
      'a global wildcard under a tenant scope',
      { 'x-test-global-permissions': '*', 'x-test-tenant-scope': 'tenant_123' },
    ],
  ])('refuses %s to invite a ar_super_admin, which is global', async (_name, extraHeaders) => {
    repo.getRole.mockResolvedValue({
      id: 'role_ar_super_admin',
      tenant_id: 'default',
      name: 'ar_super_admin',
      display_name: 'Super Admin',
      hierarchy_level: 0,
      is_system: true,
    });
    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': invitationPermissions(['*']),
          'x-test-hierarchy-level': '0',
          ...extraHeaders,
        },
        body: JSON.stringify({ email: 'peer@example.com', role_id: 'role_ar_super_admin' }),
      },
      env
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(getInvitationInsertParams()).toBeUndefined();
  });

  it('returns a stable conflict when concurrent creation hits the pending-email constraint', async () => {
    adapter.execute
      .mockResolvedValueOnce({ rowsAffected: 1 })
      .mockRejectedValueOnce(
        new Error(
          'UNIQUE constraint failed: admin_invitations.tenant_id, admin_invitations.pending_email_key'
        )
      );
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': invitationPermissions(),
        },
        body: JSON.stringify({ email: 'admin@example.com', role_id: 'role_ar_tenant_admin' }),
      },
      env
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'invitation_exists' });
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('persists a recoverable failed-delivery state when the email provider throws', async () => {
    notifier.send.mockRejectedValueOnce(new Error('provider unavailable'));
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': invitationPermissions(),
        },
        body: JSON.stringify({ email: 'admin@example.com', role_id: 'role_ar_tenant_admin' }),
      },
      env
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'email_delivery_failed',
      invitation_id: expect.any(String),
    });
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('last_delivery_status = ?'),
      expect.arrayContaining(['failed', 'Email delivery provider failed'])
    );
  });

  it('does not expose or persist a provider error returned by the notifier', async () => {
    notifier.send.mockResolvedValueOnce({
      success: false,
      error: 'Authorization: Bearer provider-secret',
    });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': invitationPermissions(),
        },
        body: JSON.stringify({ email: 'admin@example.com', role_id: 'role_ar_tenant_admin' }),
      },
      env
    );
    const responseText = await response.text();

    expect(response.status).toBe(502);
    expect(responseText).toContain('Email delivery provider rejected the message');
    expect(responseText).not.toContain('provider-secret');
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('last_delivery_status = ?'),
      expect.arrayContaining(['failed', 'Email delivery provider rejected the message'])
    );
  });

  it('expires a stale pending invitation before checking for a duplicate email', async () => {
    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-invitations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': invitationPermissions(),
        },
        body: JSON.stringify({ email: 'admin@example.com', role_id: 'role_ar_tenant_admin' }),
      },
      env
    );

    expect(response.status).toBe(201);
    const expiryCall = adapter.execute.mock.calls.find(([sql]) =>
      sql.includes("status = 'expired'")
    );
    expect(expiryCall?.[1]).toEqual([
      expect.any(Number),
      'tenant_123',
      'admin@example.com',
      expect.any(Number),
    ]);
    expect(getInvitationInsertParams()).toBeDefined();
  });

  it('does not email a replacement code when resend loses a revoke or accept race', async () => {
    adapter.queryOne.mockResolvedValueOnce({
      id: 'invitation_1',
      tenant_id: 'tenant_123',
      email: 'admin@example.com',
      name: null,
      code_hash: 'previous-code-hash',
      status: 'pending',
      admin_role_id: 'role_ar_tenant_admin',
      role_name: 'ar_tenant_admin',
      role_display_name: 'Administrator',
      scope_type: 'tenant',
      scope_id: 'tenant_123',
      role_expires_at: null,
      ip_restriction_enabled: 0,
      allowed_ip_ranges_json: '[]',
      expires_at: Date.now() + 60_000,
      last_sent_at: Date.now(),
      last_delivery_status: 'sent',
      accepted_at: null,
      created_by: 'admin_actor',
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    adapter.batch.mockResolvedValueOnce([{ rowsAffected: 0 }, { rowsAffected: 1 }]);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-invitations/invitation_1/resend',
      {
        method: 'POST',
        headers: { 'x-test-permissions': invitationPermissions() },
      },
      env
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'invitation_resend_conflict' });
    expect(notifier.send).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  describe('revoking takes the role away, so it is held to the role-removal rule', () => {
    const revoke = (
      app: ReturnType<typeof createTestApp>['app'],
      env: ReturnType<typeof createTestApp>['env'],
      headers: Record<string, string> = {}
    ) =>
      app.request(
        '/api/admin/admin-invitations/invitation_1',
        {
          method: 'DELETE',
          headers: { 'x-test-permissions': invitationPermissions(), ...headers },
        },
        env
      );
    const pending = { scope_type: 'tenant', role_name: 'ar_tenant_admin', admin_role_id: 'role_x' };
    const roleAt = (hierarchy_level: number) => ({
      id: 'role_x',
      tenant_id: 'tenant_123',
      name: 'ar_tenant_admin',
      display_name: 'Administrator',
      hierarchy_level,
      is_system: false,
    });

    it('revokes an invitation for a role ranked at or below the caller', async () => {
      adapter.queryOne.mockResolvedValueOnce(pending);
      repo.getRole.mockResolvedValue(roleAt(80));
      const { app, env } = createTestApp();

      const response = await revoke(app, env, { 'x-test-hierarchy-level': '80' });

      expect(response.status).toBe(200);
      expect(adapter.execute).toHaveBeenCalledOnce();
    });

    it('refuses an invitation for a role ranked above the caller, changing nothing', async () => {
      adapter.queryOne.mockResolvedValueOnce(pending);
      repo.getRole.mockResolvedValue(roleAt(90));
      const { app, env } = createTestApp();

      const response = await revoke(app, env, { 'x-test-hierarchy-level': '50' });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'insufficient_permissions' });
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('leaves an invitation whose role cannot be read to the strongest authority only', async () => {
      repo.getRole.mockResolvedValue(null);

      adapter.queryOne.mockResolvedValueOnce(pending);
      const lower = createTestApp();
      const refused = await revoke(lower.app, lower.env, { 'x-test-hierarchy-level': '100' });
      expect(refused.status).toBe(403);
      expect(adapter.execute).not.toHaveBeenCalled();

      adapter.queryOne.mockResolvedValueOnce(pending);
      const top = createTestApp();
      const revoked = await revoke(top.app, top.env, {
        'x-test-permissions': invitationPermissions(['*']),
        'x-test-global-permissions': '*',
        'x-test-tenant-scope': '*',
      });
      expect(revoked.status).toBe(200);
    });
  });

  describe('a resend grants the role again, so it is held to the caller as creating it is', () => {
    const pendingInvitation = (partial: Record<string, unknown> = {}) => ({
      id: 'invitation_1',
      tenant_id: 'tenant_123',
      email: 'admin@example.com',
      name: null,
      code_hash: 'previous-code-hash',
      status: 'pending',
      admin_role_id: 'role_ar_tenant_admin',
      role_name: 'ar_tenant_admin',
      role_display_name: 'Administrator',
      scope_type: 'tenant',
      scope_id: 'tenant_123',
      role_expires_at: null,
      ip_restriction_enabled: 0,
      allowed_ip_ranges_json: '[]',
      expires_at: Date.now() - 60_000,
      last_sent_at: Date.now(),
      last_delivery_status: 'sent',
      accepted_at: null,
      created_by: 'admin_actor',
      created_at: Date.now(),
      updated_at: Date.now(),
      ...partial,
    });
    const resend = (
      app: ReturnType<typeof createTestApp>['app'],
      env: ReturnType<typeof createTestApp>['env'],
      headers: Record<string, string> = {}
    ) =>
      app.request(
        '/api/admin/admin-invitations/invitation_1/resend',
        {
          method: 'POST',
          headers: { 'x-test-permissions': invitationPermissions(), ...headers },
        },
        env
      );

    it("refuses a caller who does not outrank the invitation's role", async () => {
      adapter.queryOne.mockResolvedValueOnce(pendingInvitation());
      repo.getRole.mockResolvedValue({
        id: 'role_ar_tenant_admin',
        tenant_id: 'tenant_123',
        name: 'ar_tenant_admin',
        display_name: 'Administrator',
        hierarchy_level: 80,
        is_system: false,
      });
      const { app, env } = createTestApp();

      const response = await resend(app, env, { 'x-test-hierarchy-level': '80' });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'insufficient_permissions' });
      expect(gate).not.toHaveBeenCalled();
      expect(adapter.batch).not.toHaveBeenCalled();
      expect(notifier.send).not.toHaveBeenCalled();
    });

    it('measures the role as it is now, not as it was when invited', async () => {
      adapter.queryOne.mockResolvedValueOnce(pendingInvitation());
      // Raised since the invitation was made.
      repo.getRole.mockResolvedValue({
        id: 'role_ar_tenant_admin',
        tenant_id: 'tenant_123',
        name: 'ar_tenant_admin',
        display_name: 'Administrator',
        hierarchy_level: 120,
        is_system: false,
      });
      const { app, env } = createTestApp();

      const response = await resend(app, env);

      expect(response.status).toBe(403);
      expect(adapter.batch).not.toHaveBeenCalled();
    });

    it('answers role_not_found when the role is gone', async () => {
      adapter.queryOne.mockResolvedValueOnce(pendingInvitation());
      repo.getRole.mockResolvedValue(null);
      const { app, env } = createTestApp();

      const response = await resend(app, env);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'role_not_found' });
      expect(adapter.batch).not.toHaveBeenCalled();
    });

    it('still lets a wildcard-authorized Admin resend a peer ar_super_admin invitation', async () => {
      adapter.queryOne.mockResolvedValueOnce(
        pendingInvitation({
          admin_role_id: 'role_ar_super_admin',
          role_name: 'ar_super_admin',
          scope_type: 'global',
          scope_id: null,
        })
      );
      repo.getRole.mockResolvedValue({
        id: 'role_ar_super_admin',
        tenant_id: 'default',
        name: 'ar_super_admin',
        display_name: 'Super Admin',
        hierarchy_level: 0,
        is_system: true,
      });
      const { app, env } = createTestApp();

      const response = await resend(
        app,
        { ...env, DEFAULT_TENANT_ID: 'tenant_123' },
        {
          'x-test-permissions': invitationPermissions(['*']),
          'x-test-global-permissions': '*',
          'x-test-tenant-scope': '*',
          'x-test-hierarchy-level': '0',
        }
      );

      expect(response.status).toBe(200);
      expect(adapter.batch).toHaveBeenCalledOnce();
    });
  });

  it('never resends a global invitation for a home tenant other than the default', async () => {
    adapter.queryOne.mockResolvedValueOnce({
      id: 'invitation_1',
      tenant_id: 'tenant_123',
      email: 'admin@example.com',
      name: null,
      code_hash: 'previous-code-hash',
      status: 'pending',
      admin_role_id: 'role_ar_tenant_admin',
      role_name: 'ar_tenant_admin',
      role_display_name: 'Administrator',
      scope_type: 'global',
      scope_id: null,
      role_expires_at: null,
      ip_restriction_enabled: 0,
      allowed_ip_ranges_json: '[]',
      expires_at: Date.now() - 60_000,
      last_sent_at: Date.now(),
      last_delivery_status: 'sent',
      accepted_at: null,
      created_by: 'admin_actor',
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-invitations/invitation_1/resend',
      {
        method: 'POST',
        headers: {
          'x-test-permissions': invitationPermissions(['*']),
          'x-test-global-permissions': '*',
          'x-test-tenant-scope': '*',
        },
      },
      { ...env, DEFAULT_TENANT_ID: 'platform' }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'cross_tenant_admin_requires_default_home',
    });
    expect(adapter.batch).not.toHaveBeenCalled();
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('atomically invalidates redeemed enrollment state when replacing a code', async () => {
    adapter.queryOne.mockResolvedValueOnce({
      id: 'invitation_1',
      tenant_id: 'tenant_123',
      email: 'admin@example.com',
      name: null,
      code_hash: 'previous-code-hash',
      status: 'pending',
      admin_role_id: 'role_ar_tenant_admin',
      role_name: 'ar_tenant_admin',
      role_display_name: 'Administrator',
      scope_type: 'tenant',
      scope_id: 'tenant_123',
      role_expires_at: null,
      ip_restriction_enabled: 0,
      allowed_ip_ranges_json: '[]',
      expires_at: Date.now() + 60_000,
      last_sent_at: Date.now(),
      last_delivery_status: 'sent',
      accepted_at: null,
      created_by: 'admin_actor',
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-invitations/invitation_1/resend',
      {
        method: 'POST',
        headers: { 'x-test-permissions': invitationPermissions() },
      },
      env
    );

    expect(response.status).toBe(200);
    expect(adapter.batch).toHaveBeenCalledOnce();
    const statements = adapter.batch.mock.calls[0][0];
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.sql.match(/\?/gu) ?? []).toHaveLength(statement.params?.length ?? 0);
    }
    expect(statements[0].sql).toContain('code_hash = ?');
    expect(statements[1]).toEqual({
      sql: 'DELETE FROM admin_invitation_enrollments WHERE invitation_id = ?',
      params: ['invitation_1'],
    });
    expect(notifier.send).toHaveBeenCalledOnce();
  });

  describe('admin step-up (an invitation grants a role once redeemed)', () => {
    const refusal = () =>
      new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 });
    const create = (body: Record<string, unknown>) => {
      const { app, env } = createTestApp();
      return app.request(
        '/api/admin/admin-invitations',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-test-permissions': invitationPermissions(),
          },
          body: JSON.stringify(body),
        },
        env
      );
    };
    const pendingRow = {
      id: 'invitation_1',
      tenant_id: 'tenant_123',
      email: 'admin@example.com',
      name: null,
      code_hash: 'previous-code-hash',
      status: 'pending',
      admin_role_id: 'role_ar_tenant_admin',
      role_name: 'ar_tenant_admin',
      role_display_name: 'Administrator',
      scope_type: 'tenant',
      scope_id: 'tenant_123',
      role_expires_at: 4102444800000,
      ip_restriction_enabled: 0,
      allowed_ip_ranges_json: '[]',
      expires_at: Date.now() + 60_000,
      last_sent_at: Date.now(),
      last_delivery_status: 'sent',
      accepted_at: null,
      created_by: 'admin_actor',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    it('creation is gated as admin.role.grant, bound to email, role, scope and expiry', async () => {
      const response = await create({
        email: 'NEW@EXAMPLE.COM',
        role_id: 'role_ar_tenant_admin',
        role_expires_at: 4102444800000,
        expires_in_hours: 48,
      });

      expect(response.status).toBe(201);
      expect(gate).toHaveBeenCalledTimes(1);
      expect(gate).toHaveBeenCalledWith(expect.anything(), {
        operation: 'admin.role.grant',
        targetTenantId: 'tenant_123',
        targetIds: ['new@example.com', 'role_ar_tenant_admin'],
        params: {
          invitation: 'create',
          email: 'new@example.com',
          role: 'role_ar_tenant_admin',
          scope_type: 'tenant',
          scope_id: 'tenant_123',
          role_expires_at: 4102444800000,
          expires_in_hours: 48,
          ip_restriction_enabled: false,
          allowed_ip_ranges: [],
        },
      });
    });

    it('binds the IP restriction, so lifting or changing it needs its own receipt', async () => {
      await create({
        email: 'new@example.com',
        role_id: 'role_ar_tenant_admin',
        ip_restriction_enabled: true,
        allowed_ip_ranges: ['203.0.113.0/24'],
      });
      expect(gate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          params: expect.objectContaining({
            ip_restriction_enabled: true,
            allowed_ip_ranges: ['203.0.113.0/24'],
          }) as unknown,
        })
      );
    });

    it('writes and sends nothing when the step-up is refused', async () => {
      gate.mockResolvedValueOnce(refusal());

      const response = await create({ email: 'new@example.com', role_id: 'role_ar_tenant_admin' });

      expect(response.status).toBe(403);
      expect(getInvitationInsertParams()).toBeUndefined();
      // Not even a lapsed pending invitation is marked expired before the step-up.
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(notifier.send).not.toHaveBeenCalled();
    });

    it('does not call the gate when validation or a conflict refuses the request', async () => {
      expect((await create({ email: 'not-an-email', role_id: 'role_x' })).status).toBe(400);
      repo.getRole.mockResolvedValueOnce(null);
      expect((await create({ email: 'a@example.com', role_id: 'missing' })).status).toBe(404);
      repo.findByEmail.mockResolvedValueOnce({ id: 'existing' });
      expect(
        (await create({ email: 'a@example.com', role_id: 'role_ar_tenant_admin' })).status
      ).toBe(409);
      expect(gate).not.toHaveBeenCalled();
    });

    it('resend is gated as admin.role.grant and changes nothing when refused', async () => {
      adapter.queryOne.mockResolvedValueOnce(pendingRow);
      gate.mockResolvedValueOnce(refusal());
      const { app, env } = createTestApp();

      const refused = await app.request(
        '/api/admin/admin-invitations/invitation_1/resend',
        { method: 'POST', headers: { 'x-test-permissions': invitationPermissions() } },
        env
      );

      expect(refused.status).toBe(403);
      expect(adapter.batch).not.toHaveBeenCalled();
      expect(notifier.send).not.toHaveBeenCalled();
      expect(gate).toHaveBeenCalledWith(expect.anything(), {
        operation: 'admin.role.grant',
        targetTenantId: 'tenant_123',
        targetIds: ['admin@example.com', 'role_ar_tenant_admin'],
        params: {
          invitation: 'resend',
          invitation_id: 'invitation_1',
          email: 'admin@example.com',
          role: 'role_ar_tenant_admin',
          scope_type: 'tenant',
          scope_id: 'tenant_123',
          role_expires_at: 4102444800000,
        },
      });

      adapter.queryOne.mockResolvedValueOnce(pendingRow);
      const allowed = await app.request(
        '/api/admin/admin-invitations/invitation_1/resend',
        { method: 'POST', headers: { 'x-test-permissions': invitationPermissions() } },
        env
      );
      expect(allowed.status).toBe(200);
      expect(adapter.batch).toHaveBeenCalledOnce();
    });

    it('resend of a missing invitation never reaches the gate', async () => {
      const { app, env } = createTestApp();
      const response = await app.request(
        '/api/admin/admin-invitations/nope/resend',
        { method: 'POST', headers: { 'x-test-permissions': invitationPermissions() } },
        env
      );
      expect(response.status).toBe(404);
      expect(gate).not.toHaveBeenCalled();
    });
  });
});
