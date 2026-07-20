import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const { adapter, notifier, repo, audit } = vi.hoisted(() => ({
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

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { adminInvitationsRouter } from '../routes/admin-management/admin-invitations';

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/admin-invitations', adminInvitationsRouter);
  return {
    app,
    env: {
      DB_ADMIN: {},
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
    repo.findByEmail.mockResolvedValue(null);
    repo.getRole.mockResolvedValue({
      id: 'role_admin',
      tenant_id: 'tenant_123',
      name: 'admin',
      display_name: 'Administrator',
      hierarchy_level: 10,
      is_system: false,
    });
    adapter.queryOne.mockResolvedValue(null);
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
          role_id: 'role_admin',
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
    expect(insertParams?.[18]).toBe('admin');
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
          role_id: 'role_admin',
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
          role_id: 'role_admin',
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
          role_id: 'role_admin',
          name: { unexpected: true },
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('allows a wildcard-authorized Admin to invite a peer super_admin globally', async () => {
    repo.getRole.mockResolvedValue({
      id: 'role_super_admin',
      tenant_id: 'default',
      name: 'super_admin',
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
        },
        body: JSON.stringify({ email: 'peer@example.com', role_id: 'role_super_admin' }),
      },
      env
    );

    expect(response.status).toBe(201);
    const insertParams = getInvitationInsertParams();
    expect(insertParams?.[7]).toBe('global');
    expect(insertParams?.[8]).toBeNull();
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
        body: JSON.stringify({ email: 'admin@example.com', role_id: 'role_admin' }),
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
        body: JSON.stringify({ email: 'admin@example.com', role_id: 'role_admin' }),
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
        body: JSON.stringify({ email: 'admin@example.com', role_id: 'role_admin' }),
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
        body: JSON.stringify({ email: 'admin@example.com', role_id: 'role_admin' }),
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
      admin_role_id: 'role_admin',
      role_name: 'admin',
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

  it('atomically invalidates redeemed enrollment state when replacing a code', async () => {
    adapter.queryOne.mockResolvedValueOnce({
      id: 'invitation_1',
      tenant_id: 'tenant_123',
      email: 'admin@example.com',
      name: null,
      code_hash: 'previous-code-hash',
      status: 'pending',
      admin_role_id: 'role_admin',
      role_name: 'admin',
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
});
