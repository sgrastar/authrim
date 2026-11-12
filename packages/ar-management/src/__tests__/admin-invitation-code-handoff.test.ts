import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const { adapter, notifier, repo, audit, gate, settings } = vi.hoisted(() => ({
  gate: vi.fn(async (): Promise<Response | null> => null),
  settings: vi.fn(),
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
  notifier: { send: vi.fn<(input: { body: string }) => Promise<{ success: boolean }>>() },
  repo: { findByEmail: vi.fn(), getRole: vi.fn(), effective: vi.fn() },
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => adapter),
    resolvePlatformSettingsWithSources: settings,
    AdminUserRepository: class {
      findByEmail = repo.findByEmail;
    },
    AdminRoleRepository: class {
      getRole = repo.getRole;
      getEffectivePermissions = repo.effective;
    },
    produceNotificationDelivery: vi.fn(
      async (_env: unknown, input: { payload: { body: string } }) => {
        await notifier.send(input.payload);
        return { delivery: 'delivered' };
      }
    ),
    adminAuthMiddleware:
      () =>
      async (
        c: {
          req: { header: (name: string) => string | undefined };
          set: (key: string, value: unknown) => void;
        },
        next: () => Promise<void>
      ) => {
        const list = (name: string) => (c.req.header(name) ?? '').split(',').filter(Boolean);
        c.set('adminAuth', {
          userId: 'actor_1',
          authMethod: c.req.header('x-test-auth-method') ?? 'session',
          permissions: list('x-test-permissions'),
          globalPermissions: list('x-test-global-permissions'),
          tenantScope: list('x-test-tenant-scope'),
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

import { ADMIN_PERMISSIONS, ADMIN_ROLE_DEFINITIONS } from '@authrim/ar-lib-core';
import { adminInvitationsRouter } from '../routes/admin-management/admin-invitations';

const HANDOFF = ADMIN_PERMISSIONS.ADMIN_INVITATION_CODE_HANDOFF;
const WRITE = [
  ADMIN_PERMISSIONS.ADMIN_USERS_READ,
  ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
  ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
];

/** A global machine token holding the handoff permission, as a provisioning portal would. */
const PORTAL: Record<string, string> = {
  'x-test-auth-method': 'machine_access_token',
  'x-test-permissions': [...WRITE, HANDOFF].join(','),
  'x-test-global-permissions': [...WRITE, HANDOFF].join(','),
  'x-test-tenant-scope': '*',
  'x-test-hierarchy-level': '0',
};
const asPortal = (overrides: Record<string, string> = {}) => ({ ...PORTAL, ...overrides });

const TENANT_ADMIN = {
  id: 'role_ar_tenant_admin',
  tenant_id: 'tenant_123',
  name: 'ar_tenant_admin',
  display_name: 'Administrator',
  hierarchy_level: 80,
  is_system: false,
  permissions: ['admin:users:read'],
};

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.route('/api/admin/admin-invitations', adminInvitationsRouter);
  return hono;
}
const ENV = {
  DB_ADMIN: {},
  DEFAULT_TENANT_ID: 'tenant_123',
  ADMIN_UI_URL: 'https://admin.example.com',
} as unknown as Env;

function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  env: Env = ENV
) {
  return app().request(
    `/api/admin/admin-invitations${path}`,
    {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env
  );
}

const handoffBody = (extra: Record<string, unknown> = {}) => ({
  email: 'new.admin@example.com',
  role_id: TENANT_ADMIN.id,
  code_delivery: 'response',
  ...extra,
});

const inserted = () =>
  adapter.execute.mock.calls.find(([sql]) => sql.includes('INSERT INTO admin_invitations'));
const nothingWritten = () => {
  expect(adapter.execute).not.toHaveBeenCalled();
  expect(adapter.batch).not.toHaveBeenCalled();
  expect(notifier.send).not.toHaveBeenCalled();
  expect(gate).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  gate.mockReset();
  gate.mockResolvedValue(null);
  settings.mockReset();
  settings.mockResolvedValue({ values: { 'admin_invitations.code_handoff_enabled': true } });
  repo.findByEmail.mockResolvedValue(null);
  repo.getRole.mockResolvedValue(TENANT_ADMIN);
  repo.effective.mockResolvedValue(TENANT_ADMIN.permissions);
  adapter.queryOne.mockResolvedValue(null);
  adapter.query.mockResolvedValue([]);
  adapter.execute.mockResolvedValue({ rowsAffected: 1 });
  adapter.batch.mockResolvedValue([{ rowsAffected: 1 }, { rowsAffected: 0 }]);
  notifier.send.mockResolvedValue({ success: true });
  audit.mockResolvedValue(undefined);
});

describe('creating an invitation with the code handed over', () => {
  it('returns the code once, e-mails nothing, and stores only its hash', async () => {
    const before = Date.now();
    const response = await send('POST', '', asPortal(), handoffBody());
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(body).toMatchObject({
      email: 'new.admin@example.com',
      email_sent: false,
      code_delivery: 'response',
      join_url: 'https://admin.example.com/admin/join',
    });
    const code = String(body.code);
    expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/u);
    // The default lifetime is 15 minutes.
    const lifetime = Number(body.expires_at) - before;
    expect(lifetime).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(lifetime).toBeLessThan(15 * 60 * 1000 + 5000);

    expect(notifier.send).not.toHaveBeenCalled();
    // The human step-up (admin.role.grant) is not what authorizes this mode.
    expect(gate).not.toHaveBeenCalled();

    const [sql, params] = inserted()!;
    expect(sql).toContain('code_delivery');
    expect(sql).toContain("'response'");
    expect(sql).toContain("'sent'");
    expect(sql.match(/\?/gu) ?? []).toHaveLength(params?.length ?? 0);
    // The role is recorded for the request tenant, tenant-scoped.
    expect(params?.[7]).toBe('tenant');
    expect(params?.[8]).toBe('tenant_123');

    // The plaintext code appears nowhere that is written or audited.
    const everything = JSON.stringify([
      adapter.execute.mock.calls,
      adapter.batch.mock.calls,
      audit.mock.calls,
    ]);
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(code.replaceAll('-', ''));
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0][1]).toMatchObject({
      action: 'admin_invitation.create',
      result: 'success',
      metadata: { code_delivery: 'response', email_sent: false },
    });
  });

  it('gives no join_url, and does not fail, when ADMIN_UI_URL is not a safe origin', async () => {
    for (const url of [undefined, 'http://admin.example.com', 'not a url']) {
      adapter.execute.mockClear();
      const response = await send('POST', '', asPortal(), handoffBody(), {
        ...ENV,
        ADMIN_UI_URL: url,
      });
      expect(response.status).toBe(201);
      expect((await response.json<Record<string, unknown>>()).join_url).toBeNull();
    }
  });

  it('takes expires_in_minutes up to 60, and no more', async () => {
    const ok = await send('POST', '', asPortal(), handoffBody({ expires_in_minutes: 60 }));
    expect(ok.status).toBe(201);
    adapter.execute.mockClear();
    for (const minutes of [61, 0, -5, 1.5, '30', null]) {
      const response = await send(
        'POST',
        '',
        asPortal(),
        handoffBody({ expires_in_minutes: minutes })
      );
      expect(response.status, String(minutes)).toBe(400);
    }
    nothingWritten();
  });

  describe.each([
    [
      'a human super admin, whatever their role',
      {
        'x-test-auth-method': 'session',
        'x-test-permissions': ['*', ...WRITE].join(','),
        'x-test-global-permissions': '*',
        'x-test-tenant-scope': '*',
      },
      403,
      'code_handoff_not_permitted',
    ],
    [
      'a human holding the permission by name',
      {
        'x-test-auth-method': 'session',
        'x-test-permissions': [...WRITE, HANDOFF].join(','),
        'x-test-global-permissions': HANDOFF,
        'x-test-tenant-scope': '*',
      },
      403,
      'code_handoff_not_permitted',
    ],
    [
      'a machine without the permission',
      { 'x-test-permissions': WRITE.join(','), 'x-test-global-permissions': WRITE.join(',') },
      403,
      'code_handoff_not_permitted',
    ],
    [
      'a machine with the step-up exemption of admin.role.grant only',
      {
        'x-test-permissions': [...WRITE, 'admin:step_up_exempt:admin.role.grant'].join(','),
        'x-test-global-permissions': [...WRITE, 'admin:step_up_exempt:admin.role.grant'].join(','),
      },
      403,
      'code_handoff_not_permitted',
    ],
    [
      'a machine holding * and admin:* but not the exact permission',
      {
        'x-test-permissions': ['*', 'admin:*', ...WRITE].join(','),
        'x-test-global-permissions': '*,admin:*',
      },
      403,
      'code_handoff_not_permitted',
    ],
    [
      'a machine limited to some tenants, even holding the permission',
      { 'x-test-tenant-scope': 'tenant_123', 'x-test-global-permissions': '' },
      403,
      'code_handoff_not_permitted',
    ],
    [
      'a machine with a global scope whose permissions are not global ones',
      { 'x-test-global-permissions': WRITE.join(',') },
      403,
      'code_handoff_not_permitted',
    ],
  ])('refuses %s', (_name, overrides, status, error) => {
    it('with its own error, before anything is read or written', async () => {
      const response = await send('POST', '', asPortal(overrides), handoffBody());
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
      nothingWritten();
      expect(repo.getRole).not.toHaveBeenCalled();
      expect(settings).not.toHaveBeenCalled();
    });
  });

  it('refuses while the platform switch is off, unreadable, or not exactly true', async () => {
    for (const read of [
      () => Promise.resolve({ values: { 'admin_invitations.code_handoff_enabled': false } }),
      () => Promise.resolve({ values: {} }),
      () => Promise.resolve({ values: { 'admin_invitations.code_handoff_enabled': 'true' } }),
      () => Promise.reject(new Error('settings unreadable')),
    ]) {
      settings.mockImplementation(read);
      const response = await send('POST', '', asPortal(), handoffBody());
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'code_handoff_disabled' });
    }
    nothingWritten();
    // It is read without the cache.
    expect(settings.mock.calls[0][2]).toMatchObject({ fresh: true });
  });

  it.each([
    ['a global scope', { scope_type: 'global' }, 400, 'invalid_scope'],
    ['another tenant', { scope_id: 'tenant_999' }, 400, 'invalid_scope'],
    ['admin groups', { group_ids: ['grp_1'] }, 400, 'code_handoff_groups_not_supported'],
    ['expires_in_hours', { expires_in_hours: 1 }, 400, 'invalid_expiry'],
    ['an unknown code_delivery', { code_delivery: 'sms' }, 400, 'invalid_request'],
  ])('refuses %s', async (_name, extra, status, error) => {
    const response = await send('POST', '', asPortal(), handoffBody(extra));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('refuses a global scope even from a machine that also holds the global wildcard', async () => {
    const response = await send(
      'POST',
      '',
      asPortal({ 'x-test-global-permissions': ['*', HANDOFF].join(',') }),
      handoffBody({ scope_type: 'global' })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_scope' });
    nothingWritten();
  });

  it.each([
    ['ar_super_admin', { name: 'ar_super_admin', hierarchy_level: 100, tenant_id: 'default' }],
    ['a platform role by name at a low level', { name: 'ar_super_admin', hierarchy_level: 10 }],
    ['a role at the super admin level', { hierarchy_level: 100 }],
    ['a role above the super admin level', { hierarchy_level: 150 }],
    ['a role with a negative level', { hierarchy_level: -1 }],
    ['a role with an unusable level', { hierarchy_level: Number.NaN }],
  ])('refuses %s', async (_name, role) => {
    repo.getRole.mockResolvedValue({ ...TENANT_ADMIN, is_system: true, ...role });
    const response = await send('POST', '', asPortal(), handoffBody());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'code_handoff_role_not_allowed' });
    nothingWritten();
  });

  it.each([
    ['*'],
    ['admin:*'],
    ['admin:step_up_exempt:admin.role.grant'],
    ['admin:step_up_exempt:*'],
    ['admin:support_ops:break_glass:reveal'],
    ['admin:last_resort_recovery'],
    [HANDOFF],
  ])(
    'refuses a role whose effective permissions include %s (inherited or not)',
    async (permission) => {
      // A child role with no permissions of its own, inheriting from a parent that has it.
      repo.getRole.mockResolvedValue({ ...TENANT_ADMIN, permissions: [], hierarchy_level: 50 });
      repo.effective.mockResolvedValue(['admin:users:read', permission]);
      const response = await send('POST', '', asPortal(), handoffBody());
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'code_handoff_role_not_allowed' });
      nothingWritten();
    }
  );

  it('refuses when the effective permissions cannot be resolved', async () => {
    repo.effective.mockRejectedValue(new Error('db down'));
    const response = await send('POST', '', asPortal(), handoffBody());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'code_handoff_role_not_allowed' });
    nothingWritten();
  });

  it('still allows the built-in ar_tenant_admin, on its real definition', async () => {
    const definition = ADMIN_ROLE_DEFINITIONS.find((role) => role.name === 'ar_tenant_admin')!;
    repo.getRole.mockResolvedValue({
      ...TENANT_ADMIN,
      id: definition.id,
      tenant_id: 'default',
      is_system: true,
      hierarchy_level: definition.hierarchyLevel,
      permissions: [...definition.permissions],
    });
    repo.effective.mockResolvedValue([...definition.permissions]);
    const response = await send('POST', '', asPortal(), handoffBody({ role_id: definition.id }));
    expect(response.status).toBe(201);
  });

  it('refuses a role of another tenant', async () => {
    repo.getRole.mockResolvedValue({ ...TENANT_ADMIN, tenant_id: 'tenant_999' });
    const response = await send('POST', '', asPortal(), handoffBody());
    expect(response.status).toBe(404);
    nothingWritten();
  });

  it('accepts a role at the highest level below the super admin, and at level 0', async () => {
    for (const level of [0, 99]) {
      repo.getRole.mockResolvedValue({ ...TENANT_ADMIN, hierarchy_level: level });
      expect((await send('POST', '', asPortal(), handoffBody())).status).toBe(201);
    }
  });

  it('keeps the existing permission pair required', async () => {
    const response = await send(
      'POST',
      '',
      asPortal({ 'x-test-permissions': [ADMIN_PERMISSIONS.ADMIN_USERS_READ, HANDOFF].join(',') }),
      handoffBody()
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'insufficient_permissions' });
    nothingWritten();
  });
});

describe('the other modes are not loosened', () => {
  it('still e-mails the code, and returns none, when code_delivery is omitted or email', async () => {
    for (const extra of [{}, { code_delivery: 'email' }]) {
      notifier.send.mockClear();
      const response = await send(
        'POST',
        '',
        { 'x-test-permissions': WRITE.join(','), 'x-test-hierarchy-level': '100' },
        { email: 'a@example.com', role_id: TENANT_ADMIN.id, ...extra }
      );
      const body = await response.json<Record<string, unknown>>();
      expect(response.status).toBe(201);
      expect(body).toMatchObject({ email_sent: true });
      expect(body).not.toHaveProperty('code');
      expect(response.headers.get('cache-control')).not.toBe('no-store');
      expect(notifier.send).toHaveBeenCalledOnce();
      // The column is left to its default, so the write works before the migration too.
      expect(inserted()![0]).not.toContain('code_delivery');
    }
  });

  it('rejects the handoff lifetime field on an e-mailed code', async () => {
    const response = await send(
      'POST',
      '',
      { 'x-test-permissions': WRITE.join(',') },
      { email: 'a@example.com', role_id: TENANT_ADMIN.id, expires_in_minutes: 10 }
    );
    expect(response.status).toBe(400);
    nothingWritten();
  });

  it.each([
    ['holding only the exemption', ['admin:step_up_exempt:admin.role.grant']],
    ['holding the handoff permission', [HANDOFF]],
    ['holding both', ['admin:step_up_exempt:admin.role.grant', HANDOFF]],
  ])('gives a machine %s nothing outside the handoff', async (_name, extra) => {
    const headers = asPortal({
      'x-test-permissions': [...WRITE, ...extra].join(','),
      'x-test-global-permissions': [...WRITE, ...extra].join(','),
    });
    // An ordinary role, e-mailed: refused by the hierarchy rule (a machine ranks 0).
    const ordinary = await send('POST', '', headers, {
      email: 'a@example.com',
      role_id: TENANT_ADMIN.id,
      code_delivery: 'email',
    });
    expect(ordinary.status).toBe(403);
    // A negative-level role, e-mailed: no longer passes 0 > negative.
    repo.getRole.mockResolvedValue({ ...TENANT_ADMIN, hierarchy_level: -5 });
    const negative = await send('POST', '', headers, {
      email: 'a@example.com',
      role_id: TENANT_ADMIN.id,
    });
    expect(negative.status).toBe(403);
    nothingWritten();
  });

  it('does not stop a human with a negative-level role below theirs', async () => {
    repo.getRole.mockResolvedValue({ ...TENANT_ADMIN, hierarchy_level: -5 });
    const response = await send(
      'POST',
      '',
      { 'x-test-permissions': WRITE.join(','), 'x-test-hierarchy-level': '100' },
      { email: 'a@example.com', role_id: TENANT_ADMIN.id }
    );
    expect(response.status).toBe(201);
  });

  it('still asks a human for the admin.role.grant step-up', async () => {
    await send(
      'POST',
      '',
      { 'x-test-permissions': WRITE.join(','), 'x-test-hierarchy-level': '100' },
      { email: 'a@example.com', role_id: TENANT_ADMIN.id }
    );
    expect(gate).toHaveBeenCalledOnce();
  });
});

describe('resending and revoking a handed-over invitation', () => {
  const pending = (extra: Record<string, unknown> = {}) => ({
    id: 'inv_1',
    tenant_id: 'tenant_123',
    email: 'new.admin@example.com',
    code_hash: 'hash-1',
    status: 'pending',
    admin_role_id: TENANT_ADMIN.id,
    role_name: 'ar_tenant_admin',
    role_display_name: 'Administrator',
    scope_type: 'tenant',
    scope_id: 'tenant_123',
    code_delivery: 'response',
    ...extra,
  });
  const human = { 'x-test-permissions': WRITE.join(','), 'x-test-hierarchy-level': '100' };

  it('never e-mails the code of a handed-over invitation, whoever asks', async () => {
    adapter.queryOne.mockResolvedValue(pending());
    for (const headers of [human, asPortal()]) {
      const response = await send('POST', '/inv_1/resend', headers);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'code_delivery_mismatch' });
    }
    nothingWritten();
  });

  it('re-issues the code on request under the same conditions, and returns it uncached', async () => {
    adapter.queryOne.mockResolvedValue(pending());
    const response = await send('POST', '/inv_1/resend', asPortal(), {
      code_delivery: 'response',
      expires_in_minutes: 20,
    });
    const body = await response.json<Record<string, unknown>>();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({ email_sent: false, code_delivery: 'response' });
    expect(String(body.code)).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/u);
    expect(notifier.send).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    const update = adapter.batch.mock.calls[0][0][0];
    expect(update.sql).toContain("code_delivery = 'response'");
    expect(JSON.stringify([adapter.batch.mock.calls, audit.mock.calls])).not.toContain(
      String(body.code)
    );
  });

  it.each([
    ['a human', human, 'code_handoff_not_permitted'],
    [
      'a machine without the permission',
      asPortal({
        'x-test-permissions': WRITE.join(','),
        'x-test-global-permissions': WRITE.join(','),
      }),
      'code_handoff_not_permitted',
    ],
  ])('refuses a handoff re-issue by %s', async (_name, headers, error) => {
    adapter.queryOne.mockResolvedValue(pending());
    const response = await send('POST', '/inv_1/resend', headers, { code_delivery: 'response' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error });
    nothingWritten();
  });

  it('refuses a handoff re-issue for a role that now inherits a wildcard', async () => {
    adapter.queryOne.mockResolvedValue(pending());
    repo.effective.mockResolvedValue(['admin:users:read', '*']);
    const response = await send('POST', '/inv_1/resend', asPortal(), {
      code_delivery: 'response',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'code_handoff_role_not_allowed' });
    nothingWritten();
  });

  it('refuses a handoff re-issue while the switch is off', async () => {
    adapter.queryOne.mockResolvedValue(pending());
    settings.mockResolvedValue({ values: { 'admin_invitations.code_handoff_enabled': false } });
    const response = await send('POST', '/inv_1/resend', asPortal(), {
      code_delivery: 'response',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'code_handoff_disabled' });
    nothingWritten();
  });

  it('never hands over the code of an invitation that was e-mailed', async () => {
    adapter.queryOne.mockResolvedValue(pending({ code_delivery: 'email' }));
    const response = await send('POST', '/inv_1/resend', asPortal(), {
      code_delivery: 'response',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'code_delivery_mismatch' });
    nothingWritten();
  });

  // Holding the handoff permission and nothing global that would revoke on its own.
  const narrowPortal = asPortal({ 'x-test-global-permissions': HANDOFF });

  it('lets the portal revoke an invitation it handed a code out for, on that permission alone', async () => {
    adapter.queryOne.mockResolvedValue(pending());
    const response = await send('DELETE', '/inv_1', narrowPortal);
    expect(response.status).toBe(200);
    expect(adapter.execute.mock.calls[0][0]).toContain("status = 'revoked'");
  });

  it.each([
    ['an e-mailed invitation', pending({ code_delivery: 'email' }), narrowPortal],
    [
      'a handed-over one without the permission',
      pending(),
      asPortal({ 'x-test-global-permissions': '' }),
    ],
    [
      'a handed-over one as a human holding the permission by name',
      pending(),
      {
        ...human,
        'x-test-permissions': [...WRITE, HANDOFF].join(','),
        'x-test-hierarchy-level': '0',
        'x-test-global-permissions': HANDOFF,
        'x-test-tenant-scope': '*',
      },
    ],
    ['a global invitation', pending({ scope_type: 'global' }), narrowPortal],
    ['a super admin invitation', pending({ role_name: 'ar_super_admin' }), narrowPortal],
  ])('does not let the portal revoke %s on the handoff permission', async (_name, row, headers) => {
    adapter.queryOne.mockResolvedValue(row);
    repo.getRole.mockResolvedValue(TENANT_ADMIN);
    const response = await send('DELETE', '/inv_1', headers);
    expect(response.status).toBe(403);
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
