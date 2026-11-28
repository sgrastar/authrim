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
    env?: Record<string, unknown>;
  } = {}
) {
  return {
    get: vi.fn((name: string) => (name === 'adminAuth' ? (options.auth ?? null) : undefined)),
    req: {
      query: vi.fn((name: string) => options.query?.[name]),
      param: vi.fn(() => options.id ?? 'resource-1'),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: options.env ?? {},
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
    [{ name: 'auditor', permissions: ['Documents:read'] }, 400],
    [{ name: 'auditor', permissions: ['my-docs:read'] }, 400],
    [{ name: 'auditor', permissions: ['documents:doc 42:read'] }, 400],
    [{ name: 'auditor', permissions: ['documents::read'] }, 400],
    [{ name: 'auditor', permissions: ['documents:doc_42:*'] }, 400],
    [{ name: 'auditor', permissions: ['a:b:c:d'] }, 400],
    [{ name: 'auditor', permissions: ['*:read'] }, 400],
    [{ name: 'auditor', permissions: [42] }, 400],
  ])('validates custom role create %#', async (body, status) => {
    expect((await adminRoleCreateHandler(context({ body, auth: adminAuth }))).status).toBe(status);
  });

  it.each([
    ['documents:read', 1],
    ['documents:doc_42:read', 1],
    ['documents:DOC-42.v2:read', 1],
    ['documents:*', 2],
    ['*:*', 3],
    ['*', 3],
  ])('accepts the permission %s on a new role of grant tier %i', async (permission, tier) => {
    const response = await adminRoleCreateHandler(
      context({
        body: { name: 'auditor', permissions: [permission], grant_tier: tier },
        auth: adminAuth,
      })
    );
    expect(response.status).toBe(201);
    expect(mocks.adapter.execute.mock.calls[0][1]).toContain(JSON.stringify([permission]));
  });

  it.each([
    [['documents:*'], undefined, 2],
    [['documents:*'], 1, 2],
    [['audit:read', '*'], 2, 3],
    [['*:*'], 1, 3],
  ])(
    'refuses a wildcard %j below its grant tier (asked %s, needs %i)',
    async (permissions, grantTier, required) => {
      const response = await adminRoleCreateHandler(
        context({
          body: { name: 'auditor', permissions, grant_tier: grantTier },
          auth: adminAuth,
        })
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'wildcard_requires_grant_tier',
        required_grant_tier: required,
      });
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
    }
  );

  it('lets only a tier-3 caller create a * role, and a tier-2 caller a resource:* role', async () => {
    const tier2 = { userId: 'admin-1', maxGrantTier: 2, permissions: ['admin:roles:write'] };
    const create = (permissions: string[], grant_tier: number) =>
      adminRoleCreateHandler(
        context({ body: { name: 'auditor', permissions, grant_tier }, auth: tier2 })
      );
    expect((await create(['*'], 3)).status).toBe(403);
    expect((await create(['documents:*'], 2)).status).toBe(201);
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

  it('stores and returns the display name of a new role (blank counts as none)', async () => {
    mocks.adapter.queryOne.mockResolvedValue(null);
    const named = await adminRoleCreateHandler(
      context({
        body: { name: 'auditor', display_name: '  Auditor  ', permissions: ['audit:read'] },
        auth: adminAuth,
      })
    );
    expect(named.status).toBe(201);
    await expect(named.json()).resolves.toMatchObject({ display_name: 'Auditor' });
    const insert = mocks.adapter.execute.mock.calls[0];
    expect(String(insert[0])).toMatch(/name, display_name, description/);
    expect((insert[1] as unknown[])[3]).toBe('Auditor');

    mocks.adapter.execute.mockClear();
    const blank = await adminRoleCreateHandler(
      context({
        body: { name: 'auditor2', display_name: '   ', permissions: ['audit:read'] },
        auth: adminAuth,
      })
    );
    await expect(blank.json()).resolves.toMatchObject({ display_name: null });
    expect((mocks.adapter.execute.mock.calls[0][1] as unknown[])[3]).toBeNull();

    for (const display_name of [5, 'x'.repeat(101)]) {
      expect(
        (
          await adminRoleCreateHandler(
            context({
              body: { name: 'auditor3', display_name, permissions: ['audit:read'] },
              auth: adminAuth,
            })
          )
        ).status
      ).toBe(400);
    }
  });

  it.each([null, role({ is_system: 1 }), role({ role_type: 'builtin' })])(
    'rejects missing/system role update %#',
    async (existing) => {
      mocks.adapter.queryOne.mockResolvedValueOnce(existing);
      const response = await adminRoleUpdateHandler(context({ body: {}, auth: adminAuth }));
      expect(response.status).toBe(existing ? 403 : 404);
    }
  );

  it.each([
    [{ permissions: [] }],
    [{ permissions: ['bad'] }],
    [{ permissions: ['documents:doc:42:read'] }],
  ])('validates role update permissions %#', async (body) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(role());
    expect((await adminRoleUpdateHandler(context({ body, auth: adminAuth }))).status).toBe(400);
  });

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

  it('updates a role to an ID-qualified permission and a resource wildcard', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(role({ grant_tier: 2 }));
    const permissions = ['documents:doc_42:read', 'reports:*'];
    const response = await adminRoleUpdateHandler(
      context({ body: { permissions }, auth: adminAuth })
    );
    expect(response.status).toBe(200);
    expect(mocks.adapter.execute.mock.calls[0][1]).toContain(JSON.stringify(permissions));
  });

  it('refuses a wildcard on a role below its tier, unless the same update raises the tier', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(role());
    const refused = await adminRoleUpdateHandler(
      context({ body: { permissions: ['reports:*'] }, auth: adminAuth })
    );
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      error: 'wildcard_requires_grant_tier',
      required_grant_tier: 2,
    });
    expect(mocks.adapter.execute).not.toHaveBeenCalled();

    mocks.adapter.queryOne.mockResolvedValueOnce(role());
    const raised = await adminRoleUpdateHandler(
      context({ body: { permissions: ['*'], grant_tier: 3 }, auth: adminAuth })
    );
    expect(raised.status).toBe(200);
  });

  it.each([
    ['["reports:*"]', 2, 1, 2],
    ['["*"]', 3, 2, 3],
    ['["audit:read","*:*"]', 3, 1, 3],
  ])(
    'refuses lowering the grant tier of a role holding %s (tier %i to %i)',
    async (permissionsJson, from, to, required) => {
      mocks.adapter.queryOne.mockResolvedValueOnce(
        role({ permissions_json: permissionsJson, grant_tier: from })
      );
      const response = await adminRoleUpdateHandler(
        context({ body: { grant_tier: to }, auth: adminAuth })
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'wildcard_requires_grant_tier',
        required_grant_tier: required,
      });
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
    }
  );

  it('changes only the tier of the role whose permissions were checked', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(
      role({ permissions_json: '["reports:*"]', grant_tier: 3 })
    );
    const response = await adminRoleUpdateHandler(
      context({ body: { grant_tier: 2 }, auth: adminAuth })
    );
    expect(response.status).toBe(200);
    const [sql, params] = mocks.adapter.execute.mock.calls[0] as unknown as [string, unknown[]];
    expect(String(sql)).toMatch(/AND grant_tier = \? AND permissions_json = \?/);
    expect(params).toEqual(expect.arrayContaining([3, '["reports:*"]']));
  });

  it('lets only the first of two concurrent permission edits through (409 for the other)', async () => {
    // Both edits read the role as stored; the UPDATE applies only to the role as it was read.
    const stored = { grant_tier: 2, permissions_json: '["audit:read"]' };
    mocks.adapter.queryOne.mockResolvedValue(role(stored));
    mocks.adapter.execute.mockImplementation(async (sql: string, params: unknown[]) => {
      if (!String(sql).startsWith('UPDATE roles')) return { success: true, rowsAffected: 1 };
      const [tier, permissionsJson] = params.slice(-2);
      if (tier !== stored.grant_tier || permissionsJson !== stored.permissions_json) {
        return { success: true, rowsAffected: 0 };
      }
      stored.permissions_json = String(params[1]);
      return { success: true, rowsAffected: 1 };
    });
    const [first, second] = await Promise.all([
      adminRoleUpdateHandler(context({ body: { permissions: ['audit:write'] }, auth: adminAuth })),
      adminRoleUpdateHandler(context({ body: { permissions: ['reports:*'] }, auth: adminAuth })),
    ]);
    expect([first.status, second.status]).toEqual([200, 409]);
    await expect(second.json()).resolves.toMatchObject({ error: 'role_version_conflict' });
    expect(stored.permissions_json).toBe('["audit:write"]');
    const [sql] = mocks.adapter.execute.mock.calls[0] as unknown as [string];
    expect(String(sql)).toMatch(/AND grant_tier = \? AND permissions_json = \?/);
  });

  it('drops cached claims when only the grant tier changes (repairing a wildcard role)', async () => {
    const cache = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
    mocks.adapter.queryOne.mockResolvedValueOnce(
      role({ permissions_json: '["*"]', grant_tier: 1 })
    );
    const response = await adminRoleUpdateHandler(
      context({ body: { grant_tier: 3 }, auth: adminAuth, env: { REBAC_CACHE: cache } })
    );
    expect(response.status).toBe(200);
    expect(cache.put).toHaveBeenCalledWith(
      expect.stringContaining('tenant-version:tenant-a'),
      expect.any(String)
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
    await expect(update.json()).resolves.toMatchObject({ error: 'role_version_conflict' });
    expect(String(mocks.adapter.execute.mock.calls[0][0])).toMatch(
      /WHERE tenant_id = \? AND id = \? AND grant_tier = \? AND permissions_json = \?/
    );
    expect((mocks.adapter.execute.mock.calls[0][1] as unknown[]).slice(-4)).toEqual([
      'tenant-a',
      'resource-1',
      2,
      '["audit:read"]',
    ]);
    expect(mocks.audit).not.toHaveBeenCalled();

    mocks.adapter.execute.mockClear();
    mocks.adapter.queryOne.mockResolvedValueOnce(role({ grant_tier: 2 }));
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    // The tier changed since it was read.
    mocks.adapter.queryOne.mockResolvedValueOnce({ grant_tier: 3 });
    const removal = await adminRoleDeleteHandler(context({ auth: adminAuth }));
    expect(removal.status).toBe(409);
    await expect(removal.json()).resolves.toMatchObject({ error: 'role_version_conflict' });
    expect(String(mocks.adapter.execute.mock.calls[0][0])).toMatch(/AND grant_tier = \?/);
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual([
      'tenant-a',
      'resource-1',
      2,
      'tenant-a',
      'resource-1',
    ]);
  });

  it('says why a guarded delete removed nothing: a group grant, or the role gone', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(role({ grant_tier: 2 }));
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    mocks.adapter.queryOne.mockResolvedValueOnce({ grant_tier: 2 });
    const held = await adminRoleDeleteHandler(context({ auth: adminAuth }));
    expect(held.status).toBe(409);
    await expect(held.json()).resolves.toMatchObject({ error: 'role_in_use' });

    mocks.adapter.queryOne.mockResolvedValueOnce(role({ grant_tier: 2 }));
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    mocks.adapter.queryOne.mockResolvedValueOnce(null);
    expect((await adminRoleDeleteHandler(context({ auth: adminAuth }))).status).toBe(404);
  });

  it('does not delete assigned custom roles', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(role());
    mocks.adapter.query.mockResolvedValueOnce([{ key: 'resource-1', count: 2 }]);
    const refused = await adminRoleDeleteHandler(context({ auth: adminAuth }));
    expect(refused.status).toBe(409);
    const refusal = await refused.text();
    expect(refusal).toContain('"error":"role_in_use"');
    expect(refusal).toContain('2 user(s)');
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
