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
  adminRoleCreateHandler,
  adminRoleDeleteHandler,
  adminRoleGetHandler,
  adminRolesListHandler,
  adminRoleUpdateHandler,
} from '../admin-rbac';

// Admin operations are recorded through the forwarding shim (see the helper).
vi.mock('../admin-operation-audit', () => import('./helpers/legacy-admin-audit-shim'));

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

function role(overrides: Record<string, unknown> = {}) {
  return {
    id: 'role-1',
    tenant_id: 'tenant-a',
    name: 'auditor',
    display_name: 'Auditor',
    description: null,
    permissions_json: '["audit:read"]',
    is_system: 0,
    role_type: 'custom',
    grant_tier: 1,
    created_at: 100,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

const adminAuth = { userId: 'admin-1', maxGrantTier: 3, permissions: ['admin:*'] };

describe('admin RBAC role CRUD', () => {
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

  it('lists roles with assignment counts and timestamp normalization', async () => {
    mocks.adapter.query
      .mockResolvedValueOnce([role(), role({ id: 'role-2', is_system: 1, created_at: null })])
      .mockResolvedValueOnce([{ key: 'role-1', count: 2 }]);
    await expect((await adminRolesListHandler(context())).json()).resolves.toMatchObject({
      roles: [
        { id: 'role-1', assignment_count: 2, is_system: false },
        { id: 'role-2', assignment_count: 0, is_system: true, created_at: null },
      ],
    });
  });

  it('gets a role with its own permissions only (roles do not inherit)', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(role());
    mocks.adapter.query.mockResolvedValueOnce([{ key: 'resource-1', count: 3 }]);
    const body = (await (await adminRoleGetHandler(context())).json()) as {
      role: Record<string, unknown>;
    };
    expect(body.role).toMatchObject({
      assignment_count: 3,
      added_permissions: ['audit:read'],
      effective_permissions: ['audit:read'],
    });
    expect(body.role).not.toHaveProperty('parent_role');
    expect(mocks.adapter.queryOne).toHaveBeenCalledTimes(1);
  });

  it.each([null, role({ permissions_json: null })])(
    'gets missing/standalone role %#',
    async (value) => {
      mocks.adapter.queryOne.mockResolvedValueOnce(value).mockResolvedValueOnce(null);
      const response = await adminRoleGetHandler(context());
      expect(response.status).toBe(value ? 200 : 404);
    }
  );

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

  it('requires a grant tier to create a role, whatever the hierarchy level', async () => {
    expect(
      (
        await adminRoleCreateHandler(
          context({
            body: { name: 'auditor', permissions: ['audit:read'] },
            auth: { hierarchyLevel: 100 },
          })
        )
      ).status
    ).toBe(403);
  });

  it('rejects a duplicate role name', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ id: 'existing' });
    expect(
      (
        await adminRoleCreateHandler(
          context({ body: { name: 'auditor', permissions: ['audit:read'] }, auth: adminAuth })
        )
      ).status
    ).toBe(400);
  });

  it('creates and audits a custom role of the lowest grant tier, without hierarchy or parent', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(null);
    const response = await adminRoleCreateHandler(
      context({
        body: {
          name: 'auditor',
          description: 'Read audit',
          permissions: ['audit:read'],
          // No longer fields of a role: ignored.
          parent_role_id: 'parent',
          hierarchy_level: 2,
        },
        auth: { userId: 'admin-1', maxGrantTier: 1, permissions: ['admin:roles:write'] },
      })
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ role_id: 'role-new', grant_tier: 1 });
    const insert = mocks.adapter.execute.mock.calls[0];
    expect(String(insert[0])).not.toMatch(/hierarchy_level|parent_role_id/);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'role.created',
      'role',
      'role-new',
      expect.anything()
    );
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

  it('updates the description and permissions of a role', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(role());
    const response = await adminRoleUpdateHandler(
      context({
        body: { description: '', permissions: ['audit:write'] },
        auth: adminAuth,
      })
    );
    expect(response.status).toBe(200);
    expect(String(mocks.adapter.execute.mock.calls[0][0])).not.toMatch(
      /hierarchy_level|parent_role_id/
    );
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual(
      expect.arrayContaining([null, '["audit:write"]', 'tenant-a', 'resource-1'])
    );
  });

  it('refuses a role above the caller grant tier', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(role({ grant_tier: 3 }));
    const response = await adminRoleUpdateHandler(
      context({
        body: { permissions: ['audit:write'] },
        auth: { userId: 'admin-1', maxGrantTier: 2, permissions: ['admin:roles:write'] },
      })
    );
    expect(response.status).toBe(403);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it('creates a role of the asked grant tier when the caller may grant it', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(null);
    const response = await adminRoleCreateHandler(
      context({
        body: { name: 'approver', permissions: ['audit:read'], grant_tier: 2 },
        auth: { userId: 'admin-1', maxGrantTier: 2, permissions: ['admin:roles:write'] },
      })
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ grant_tier: 2 });
    expect(String(mocks.adapter.execute.mock.calls[0][0])).toMatch(/grant_tier/);
    expect(mocks.adapter.execute.mock.calls[0][1]).toContain(2);
  });

  it('refuses to create a role above the caller grant tier', async () => {
    const response = await adminRoleCreateHandler(
      context({
        body: { name: 'approver', permissions: ['audit:read'], grant_tier: 3 },
        auth: { userId: 'admin-1', maxGrantTier: 2, permissions: ['admin:roles:write'] },
      })
    );
    expect(response.status).toBe(403);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it.each([0, 4, 1.5, '2', null])('rejects the grant tier %s on create', async (grantTier) => {
    const response = await adminRoleCreateHandler(
      context({
        body: { name: 'approver', permissions: ['audit:read'], grant_tier: grantTier },
        auth: adminAuth,
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it('changes the grant tier of a role within the caller tier, and refuses a higher one', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(role());
    const ok = await adminRoleUpdateHandler(
      context({
        body: { grant_tier: 2 },
        auth: { userId: 'admin-1', maxGrantTier: 2, permissions: ['admin:roles:write'] },
      })
    );
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ grant_tier: 2 });
    expect(String(mocks.adapter.execute.mock.calls[0][0])).toMatch(/grant_tier = \?/);

    mocks.adapter.execute.mockClear();
    mocks.adapter.queryOne.mockResolvedValueOnce(role());
    const refused = await adminRoleUpdateHandler(
      context({
        body: { grant_tier: 3 },
        auth: { userId: 'admin-1', maxGrantTier: 2, permissions: ['admin:roles:write'] },
      })
    );
    expect(refused.status).toBe(403);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();

    mocks.adapter.queryOne.mockResolvedValueOnce(role());
    expect(
      (await adminRoleUpdateHandler(context({ body: { grant_tier: 9 }, auth: adminAuth }))).status
    ).toBe(400);
  });

  it.each([
    [null, 404],
    [role({ grant_tier: 4 }), 403],
    [role({ is_system: 1 }), 403],
    [role(), 200],
  ])('deletes custom role result %#', async (existing, status) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(existing).mockResolvedValueOnce({ count: 0 });
    const response = await adminRoleDeleteHandler(context({ auth: adminAuth }));
    expect(response.status).toBe(status);
  });

  it('updates or deletes only the role at the grant tier it was checked at (409 otherwise)', async () => {
    // Another administrator changed the tier between the read and the write: nothing matches.
    mocks.adapter.queryOne.mockResolvedValueOnce(role({ grant_tier: 2 }));
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const update = await adminRoleUpdateHandler(
      context({ body: { permissions: ['audit:write'] }, auth: adminAuth })
    );
    expect(update.status).toBe(409);
    expect(String(mocks.adapter.execute.mock.calls[0][0])).toMatch(
      /WHERE tenant_id = \? AND id = \? AND grant_tier = \?/
    );
    expect((mocks.adapter.execute.mock.calls[0][1] as unknown[]).slice(-3)).toEqual([
      'tenant-a',
      'resource-1',
      2,
    ]);
    expect(mocks.audit).not.toHaveBeenCalled();

    mocks.adapter.execute.mockClear();
    mocks.adapter.queryOne.mockResolvedValueOnce(role({ grant_tier: 2 }));
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const removal = await adminRoleDeleteHandler(context({ auth: adminAuth }));
    expect(removal.status).toBe(409);
    expect(String(mocks.adapter.execute.mock.calls[0][0])).toMatch(/AND grant_tier = \?/);
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual([
      'tenant-a',
      'resource-1',
      2,
      'tenant-a',
      'resource-1',
    ]);
  });

  it('does not delete assigned custom roles', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(role());
    mocks.adapter.query.mockResolvedValueOnce([{ key: 'resource-1', count: 2 }]);
    expect((await adminRoleDeleteHandler(context({ auth: adminAuth }))).status).toBe(409);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it.each([
    [adminRolesListHandler],
    [adminRoleGetHandler],
    [adminRoleCreateHandler],
    [adminRoleUpdateHandler],
    [adminRoleDeleteHandler],
  ])('returns server_error for RBAC storage failures %#', async (handler) => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await handler(
          context({ body: { name: 'auditor', permissions: ['audit:read'] }, auth: adminAuth })
        )
      ).status
    ).toBe(500);
  });
});
