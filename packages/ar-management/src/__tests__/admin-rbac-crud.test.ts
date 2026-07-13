import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  audit: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    hasPIIDatabase: vi.fn(() => false),
    createAuditLogFromContext: mocks.audit,
    generateId: vi.fn(() => 'role-new'),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
    createErrorResponse: vi.fn((c, code, options) => {
      const status =
        code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND
          ? 404
          : code === actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS
            ? 403
            : 400;
      return c.json({ error: code, ...options }, status);
    }),
  };
});

import {
  adminOrganizationCreateHandler,
  adminOrganizationDeleteHandler,
  adminOrganizationGetHandler,
  adminOrganizationsListHandler,
  adminOrganizationUpdateHandler,
  adminRoleCreateHandler,
  adminRoleDeleteHandler,
  adminRoleGetHandler,
  adminRolesListHandler,
  adminRoleUpdateHandler,
} from '../admin-rbac';

function context(
  options: {
    query?: Record<string, string | undefined>;
    id?: string;
    body?: unknown;
    auth?: Record<string, unknown>;
  } = {}
) {
  return {
    get: vi.fn((name: string) => (name === 'adminAuth' ? (options.auth ?? null) : undefined)),
    req: {
      query: vi.fn((name: string) => options.query?.[name]),
      param: vi.fn(() => options.id ?? 'resource-1'),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function organization(overrides: Record<string, unknown> = {}) {
  return {
    id: 'org-1', tenant_id: 'tenant-a', name: 'acme', display_name: 'Acme',
    plan: 'professional', org_type: 'team', is_active: 1,
    created_at: 100, updated_at: 1_700_000_000_000, ...overrides,
  };
}

function role(overrides: Record<string, unknown> = {}) {
  return {
    id: 'role-1', tenant_id: 'tenant-a', name: 'auditor', display_name: 'Auditor',
    description: null, permissions_json: '["audit:read"]', is_system: 0,
    role_type: 'custom', parent_role_id: null, hierarchy_level: 1,
    created_at: 100, updated_at: 1_700_000_000_000, ...overrides,
  };
}

const adminAuth = { userId: 'admin-1', hierarchyLevel: 100, permissions: ['admin:*'] };

describe('admin RBAC organization and role CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.audit.mockResolvedValue(undefined);
  });

  it.each([
    [{}, ['tenant-a', 20, 0]],
    [
      { page: '2', limit: '10', search: '100%_team', is_active: 'true', plan: 'professional', org_type: 'team' },
      ['tenant-a', '%100\\%\\_team%', '%100\\%\\_team%', 1, 'professional', 'team', 10, 10],
    ],
    [{ is_active: 'false' }, ['tenant-a', 0, 20, 0]],
  ])('lists organizations with tenant filters %#', async (query, expectedBindings) => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ count: 21 });
    mocks.adapter.query.mockResolvedValueOnce([organization(), organization({ is_active: 0, created_at: 0 })]);
    const body = (await (await adminOrganizationsListHandler(context({ query }))).json()) as {
      organizations: Array<Record<string, unknown>>;
      pagination: Record<string, unknown>;
    };
    expect(body.organizations).toEqual([
      expect.objectContaining({ is_active: true, created_at: 100_000 }),
      expect.objectContaining({ is_active: false, created_at: null }),
    ]);
    expect(mocks.adapter.query.mock.calls[0][1]).toEqual(expectedBindings);
  });

  it('defaults absent organization counts and handles list failures', async () => {
    await expect((await adminOrganizationsListHandler(context())).json()).resolves.toMatchObject({
      pagination: { total: 0, hasNext: false, hasPrev: false },
    });
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminOrganizationsListHandler(context())).status).toBe(500);
  });

  it.each([null, organization()])('gets organization result %#', async (org) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(org).mockResolvedValueOnce({ count: 3 });
    const response = await adminOrganizationGetHandler(context());
    expect(response.status).toBe(org ? 200 : 404);
    if (org) await expect(response.json()).resolves.toMatchObject({ organization: { member_count: 3 } });
  });

  it('handles organization get failures', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminOrganizationGetHandler(context())).status).toBe(500);
  });

  it('requires organization name and rejects duplicates', async () => {
    expect((await adminOrganizationCreateHandler(context({ body: {} }))).status).toBe(400);
    mocks.adapter.queryOne.mockResolvedValueOnce({ id: 'existing' });
    expect((await adminOrganizationCreateHandler(context({ body: { name: 'acme' } }))).status).toBe(409);
  });

  it.each([
    [{ name: 'acme' }, 'free', 'team'],
    [{ name: 'acme', display_name: 'Acme', plan: 'enterprise', org_type: 'partner', metadata_json: '{}' }, 'enterprise', 'partner'],
    [{ name: 'acme', plan: 'invalid', org_type: 'invalid' }, 'free', 'team'],
  ])('creates organization with normalized plan/type %#', async (body, plan, orgType) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(organization({ plan, org_type: orgType }));
    const response = await adminOrganizationCreateHandler(context({ body }));
    expect(response.status).toBe(201);
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual(expect.arrayContaining(['tenant-a', 'acme', plan, orgType]));
  });

  it('handles organization create failures', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminOrganizationCreateHandler(context({ body: { name: 'acme' } }))).status).toBe(500);
  });

  it('does not update missing organizations or empty requests', async () => {
    expect((await adminOrganizationUpdateHandler(context({ body: {} }))).status).toBe(404);
    mocks.adapter.queryOne.mockResolvedValueOnce({ id: 'org-1' });
    expect((await adminOrganizationUpdateHandler(context({ body: {} }))).status).toBe(400);
  });

  it.each([[{ plan: 'invalid' }], [{ org_type: 'invalid' }]])(
    'rejects invalid organization update %#',
    async (body) => {
      mocks.adapter.queryOne.mockResolvedValueOnce({ id: 'org-1' });
      expect((await adminOrganizationUpdateHandler(context({ body }))).status).toBe(400);
    }
  );

  it('updates all organization fields including inactive state', async () => {
    const body = {
      name: 'new', display_name: '', plan: 'starter', org_type: 'personal',
      is_active: false, metadata_json: '',
    };
    mocks.adapter.queryOne
      .mockResolvedValueOnce({ id: 'org-1' })
      .mockResolvedValueOnce(organization({ name: 'new', is_active: 0 }));
    expect((await adminOrganizationUpdateHandler(context({ body }))).status).toBe(200);
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['new', '', 'starter', 'personal', 0, '', 'tenant-a', 'resource-1'])
    );
  });

  it.each([null, { id: 'org-1' }])('soft deletes organization result %#', async (org) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(org);
    const response = await adminOrganizationDeleteHandler(context());
    expect(response.status).toBe(org ? 200 : 404);
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(org ? 1 : 0);
  });

  it('lists roles with assignment counts and timestamp normalization', async () => {
    mocks.adapter.query
      .mockResolvedValueOnce([role(), role({ id: 'role-2', is_system: 1, created_at: null })])
      .mockResolvedValueOnce([{ role_id: 'role-1', count: 2 }]);
    await expect((await adminRolesListHandler(context())).json()).resolves.toMatchObject({
      roles: [
        { id: 'role-1', assignment_count: 2, is_system: false },
        { id: 'role-2', assignment_count: 0, is_system: true, created_at: null },
      ],
    });
  });

  it('gets role with inherited deduplicated permissions', async () => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce(role({ parent_role_id: 'parent' }))
      .mockResolvedValueOnce(role({ id: 'parent', permissions_json: '["audit:read","user:read"]' }))
      .mockResolvedValueOnce({ count: 3 });
    await expect((await adminRoleGetHandler(context())).json()).resolves.toMatchObject({
      role: {
        assignment_count: 3,
        added_permissions: ['audit:read'],
        effective_permissions: ['audit:read', 'user:read'],
        parent_role: { id: 'parent' },
      },
    });
  });

  it.each([null, role({ permissions_json: null })])('gets missing/standalone role %#', async (value) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(value).mockResolvedValueOnce(null);
    const response = await adminRoleGetHandler(context());
    expect(response.status).toBe(value ? 200 : 404);
  });

  it.each([
    [{}, 400],
    [{ name: 'x', permissions: ['audit:read'] }, 400],
    [{ name: '1bad', permissions: ['audit:read'] }, 400],
    [{ name: 'admin', permissions: ['audit:read'] }, 400],
    [{ name: 'auditor', permissions: [] }, 400],
    [{ name: 'auditor', permissions: ['bad'] }, 400],
  ])('validates custom role create %#', async (body, status) => {
    expect((await adminRoleCreateHandler(context({ body, auth: adminAuth }))).status).toBe(status);
  });

  it('requires sufficient hierarchy to create a role', async () => {
    expect(
      (
        await adminRoleCreateHandler(
          context({ body: { name: 'auditor', permissions: ['audit:read'] }, auth: { hierarchyLevel: 0 } })
        )
      ).status
    ).toBe(403);
  });

  it('rejects duplicate and missing/inaccessible parent roles', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ id: 'existing' });
    expect(
      (
        await adminRoleCreateHandler(
          context({ body: { name: 'auditor', permissions: ['audit:read'] }, auth: adminAuth })
        )
      ).status
    ).toBe(400);

    mocks.adapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(
      (
        await adminRoleCreateHandler(
          context({ body: { name: 'child', permissions: ['audit:read'], inherits_from: 'missing' }, auth: adminAuth })
        )
      ).status
    ).toBe(404);

    mocks.adapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'parent', hierarchy_level: 100 });
    expect(
      (
        await adminRoleCreateHandler(
          context({ body: { name: 'child', permissions: ['audit:read'], parent_role_id: 'parent' }, auth: adminAuth })
        )
      ).status
    ).toBe(403);
  });

  it('creates and audits a custom child role', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'parent', hierarchy_level: 1 });
    const response = await adminRoleCreateHandler(
      context({
        body: {
          name: 'auditor', description: 'Read audit', permissions: ['audit:read'],
          parent_role_id: 'parent', hierarchy_level: 2,
        },
        auth: adminAuth,
      })
    );
    expect(response.status).toBe(201);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), 'role.created', 'role', 'role-new', expect.anything());
  });

  it.each([null, role({ is_system: 1 }), role({ role_type: 'builtin' })])(
    'rejects missing/system role update %#',
    async (existing) => {
      mocks.adapter.queryOne.mockResolvedValueOnce(existing);
      const response = await adminRoleUpdateHandler(context({ body: {}, auth: adminAuth }));
      expect(response.status).toBe(existing ? 403 : 404);
    }
  );

  it.each([[{ permissions: [] }], [{ permissions: ['bad'] }]])(
    'validates role update permissions %#',
    async (body) => {
      mocks.adapter.queryOne.mockResolvedValueOnce(role());
      expect((await adminRoleUpdateHandler(context({ body, auth: adminAuth }))).status).toBe(400);
    }
  );

  it('updates role fields and can clear parent', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(role());
    const response = await adminRoleUpdateHandler(
      context({
        body: { description: '', permissions: ['audit:write'], hierarchy_level: 2, parent_role_id: null },
        auth: adminAuth,
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual(
      expect.arrayContaining([null, '["audit:write"]', 2, null, 'tenant-a', 'resource-1'])
    );
  });

  it.each([
    [null, 404],
    [role({ hierarchy_level: 100 }), 403],
    [role({ is_system: 1 }), 403],
    [role(), 200],
  ])('deletes custom role result %#', async (existing, status) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(existing).mockResolvedValueOnce({ count: 0 });
    const response = await adminRoleDeleteHandler(context({ auth: adminAuth }));
    expect(response.status).toBe(status);
  });

  it('does not delete assigned custom roles', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(role()).mockResolvedValueOnce({ count: 2 });
    expect((await adminRoleDeleteHandler(context({ auth: adminAuth }))).status).toBe(409);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it.each([
    [adminOrganizationsListHandler],
    [adminRolesListHandler],
    [adminRoleGetHandler],
    [adminRoleCreateHandler],
    [adminRoleUpdateHandler],
    [adminRoleDeleteHandler],
  ])('returns server_error for RBAC storage failures %#', async (handler) => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await handler(context({ body: { name: 'auditor', permissions: ['audit:read'] }, auth: adminAuth }))).status).toBe(500);
  });
});
