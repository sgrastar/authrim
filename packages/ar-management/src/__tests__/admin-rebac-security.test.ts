import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  listDefinitions: vi.fn(),
  getDefinition: vi.fn(),
  getDefinitionByName: vi.fn(),
  createDefinition: vi.fn(),
  updateDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
  listRelationships: vi.fn(),
  getRelationship: vi.fn(),
  hasRelationship: vi.fn(),
  createRelationship: vi.fn(),
  deleteRelationship: vi.fn(),
  getRelationshipsFrom: vi.fn(),
  getRelationshipsTo: vi.fn(),
  findAdmin: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();

  class DefinitionRepository {
    listDefinitions = mocks.listDefinitions;
    getDefinition = mocks.getDefinition;
    getDefinitionByName = mocks.getDefinitionByName;
    createDefinition = mocks.createDefinition;
    updateDefinition = mocks.updateDefinition;
    deleteDefinition = mocks.deleteDefinition;
  }

  class RelationshipRepository {
    listRelationships = mocks.listRelationships;
    getRelationship = mocks.getRelationship;
    hasRelationship = mocks.hasRelationship;
    createRelationship = mocks.createRelationship;
    deleteRelationship = mocks.deleteRelationship;
    getRelationshipsFrom = mocks.getRelationshipsFrom;
    getRelationshipsTo = mocks.getRelationshipsTo;
  }

  class UserRepository {
    findByTenantAndId = mocks.findAdmin;
  }

  return {
    ...actual,
    AdminRebacDefinitionRepository: DefinitionRepository,
    AdminRelationshipRepository: RelationshipRepository,
    AdminUserRepository: UserRepository,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    adminAuthMiddleware:
      () =>
      async (
        c: {
          req: { header: (name: string) => string | undefined };
          set: (key: string, value: unknown) => void;
        },
        next: () => Promise<void>
      ) => {
        c.set('tenantId', c.req.header('x-test-tenant') ?? 'tenant-a');
        c.set('adminAuth', {
          userId: 'actor-a',
          permissions: (c.req.header('x-test-permissions') ?? '').split(',').filter(Boolean),
        });
        await next();
      },
    getTenantIdFromContext: (c: { get: (key: string) => unknown }) => c.get('tenantId'),
  };
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.audit }));

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { adminRebacRouter } from '../routes/admin-management/admin-rebac';

const readHeaders = { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_READ };
const writeHeaders = {
  'Content-Type': 'application/json',
  'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_READ},${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE}`,
};

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.route('/api/admin', adminRebacRouter);
  return instance;
}

function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'definition-a',
    tenant_id: 'tenant-a',
    relation_name: 'manager',
    is_system: false,
    ...overrides,
  };
}

function relationship(overrides: Record<string, unknown> = {}) {
  return {
    id: 'relationship-a',
    tenant_id: 'tenant-a',
    relationship_type: 'manager',
    from_id: 'admin-a',
    to_id: 'resource-a',
    ...overrides,
  };
}

async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = writeHeaders
) {
  return app().request(
    path,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { DB_ADMIN: {} } as never
  );
}

describe('admin ReBAC security boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAdmin.mockResolvedValue({ id: 'admin-a', tenant_id: 'tenant-a' });
    mocks.getDefinition.mockResolvedValue(definition());
    mocks.getRelationship.mockResolvedValue(relationship());
    mocks.getRelationshipsFrom.mockResolvedValue([]);
    mocks.getRelationshipsTo.mockResolvedValue([]);
  });

  it('lists definitions using bounded tenant input and hides foreign definitions', async () => {
    mocks.listDefinitions.mockResolvedValue([definition()]);
    const list = await request(
      '/api/admin/admin-rebac-definitions?include_system=false&limit=25&offset=5',
      'GET',
      undefined,
      readHeaders
    );
    expect(list.status).toBe(200);
    expect(mocks.listDefinitions).toHaveBeenCalledWith('tenant-a', {
      includeSystem: false,
      limit: 25,
      offset: 5,
    });

    mocks.getDefinition.mockResolvedValue(definition({ tenant_id: 'tenant-b' }));
    expect(
      (
        await request(
          '/api/admin/admin-rebac-definitions/definition-b',
          'GET',
          undefined,
          readHeaders
        )
      ).status
    ).toBe(404);

    mocks.getDefinition.mockResolvedValue(definition({ tenant_id: 'system', is_system: true }));
    expect(
      (await request('/api/admin/admin-rebac-definitions/system', 'GET', undefined, readHeaders))
        .status
    ).toBe(200);
  });

  it.each([
    ['POST', '/api/admin/admin-rebac-definitions', { relation_name: 'manager' }],
    ['PATCH', '/api/admin/admin-rebac-definitions/definition-a', { display_name: 'Manager' }],
    ['DELETE', '/api/admin/admin-rebac-definitions/definition-a', undefined],
    [
      'POST',
      '/api/admin/admin-relationships',
      { relationship_type: 'manager', from_id: 'admin-a', to_id: 'resource-a' },
    ],
    ['DELETE', '/api/admin/admin-relationships/relationship-a', undefined],
    [
      'POST',
      '/api/admin/admins/admin-a/relationships',
      { relationship_type: 'manager', to_id: 'resource-a' },
    ],
    ['DELETE', '/api/admin/admins/admin-a/relationships/relationship-a', undefined],
  ])(
    'denies %s %s without write permission and has no mutation side effect',
    async (method, path, body) => {
      const response = await request(path, method, body, {
        'Content-Type': 'application/json',
        ...readHeaders,
      });
      expect(response.status).toBe(403);
      expect(mocks.createDefinition).not.toHaveBeenCalled();
      expect(mocks.updateDefinition).not.toHaveBeenCalled();
      expect(mocks.deleteDefinition).not.toHaveBeenCalled();
      expect(mocks.createRelationship).not.toHaveBeenCalled();
      expect(mocks.deleteRelationship).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    }
  );

  it('validates definition creation, prevents duplicates and blocks mass assignment', async () => {
    expect((await request('/api/admin/admin-rebac-definitions', 'POST', {})).status).toBe(400);
    mocks.getDefinitionByName.mockResolvedValue(definition());
    expect(
      (
        await request('/api/admin/admin-rebac-definitions', 'POST', {
          relation_name: 'manager',
        })
      ).status
    ).toBe(409);

    mocks.getDefinitionByName.mockResolvedValue(null);
    mocks.createDefinition.mockResolvedValue(definition());
    const response = await request('/api/admin/admin-rebac-definitions', 'POST', {
      relation_name: 'manager',
      priority: 10,
      tenant_id: 'tenant-b',
      is_system: true,
    });
    expect(response.status).toBe(201);
    expect(mocks.createDefinition).toHaveBeenCalledWith({
      tenant_id: 'tenant-a',
      relation_name: 'manager',
      display_name: undefined,
      description: undefined,
      priority: 10,
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'admin_rebac_definition.create' })
    );
  });

  it('protects foreign and system definitions from mutation', async () => {
    mocks.getDefinition.mockResolvedValue(definition({ tenant_id: 'tenant-b' }));
    expect(
      (
        await request('/api/admin/admin-rebac-definitions/definition-a', 'PATCH', {
          display_name: 'Hijacked',
        })
      ).status
    ).toBe(404);

    mocks.getDefinition.mockResolvedValue(definition({ is_system: true }));
    expect(
      (
        await request('/api/admin/admin-rebac-definitions/definition-a', 'PATCH', {
          display_name: 'Changed',
        })
      ).status
    ).toBe(403);
    expect(
      (await request('/api/admin/admin-rebac-definitions/definition-a', 'DELETE')).status
    ).toBe(403);
    expect(mocks.updateDefinition).not.toHaveBeenCalled();
    expect(mocks.deleteDefinition).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('updates and deletes tenant definitions and audits only successful changes', async () => {
    mocks.updateDefinition.mockResolvedValue(definition({ display_name: 'Manager' }));
    expect(
      (
        await request('/api/admin/admin-rebac-definitions/definition-a', 'PATCH', {
          display_name: 'Manager',
        })
      ).status
    ).toBe(200);

    mocks.deleteDefinition.mockResolvedValue(true);
    expect(
      (await request('/api/admin/admin-rebac-definitions/definition-a', 'DELETE')).status
    ).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'admin_rebac_definition.delete' })
    );
  });

  it('handles definition disappearance and repository policy failures without success audit', async () => {
    mocks.getDefinition.mockResolvedValueOnce(null);
    expect(
      (await request('/api/admin/admin-rebac-definitions/missing', 'GET', undefined, readHeaders))
        .status
    ).toBe(404);

    mocks.getDefinition.mockResolvedValueOnce(null);
    expect(
      (
        await request('/api/admin/admin-rebac-definitions/missing', 'PATCH', {
          display_name: 'Missing',
        })
      ).status
    ).toBe(404);

    mocks.getDefinition.mockResolvedValue(definition());
    mocks.updateDefinition.mockResolvedValue(null);
    expect(
      (
        await request('/api/admin/admin-rebac-definitions/definition-a', 'PATCH', {
          display_name: 'Raced',
        })
      ).status
    ).toBe(404);

    mocks.getDefinition.mockResolvedValueOnce(null);
    expect((await request('/api/admin/admin-rebac-definitions/missing', 'DELETE')).status).toBe(
      404
    );

    mocks.getDefinition.mockResolvedValue(definition());
    mocks.deleteDefinition.mockResolvedValue(false);
    expect(
      (await request('/api/admin/admin-rebac-definitions/definition-a', 'DELETE')).status
    ).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('lists and retrieves only current-tenant relationships', async () => {
    mocks.listRelationships.mockResolvedValue({ relationships: [relationship()], total: 1 });
    const list = await request(
      '/api/admin/admin-relationships?type=manager&limit=10&offset=2',
      'GET',
      undefined,
      readHeaders
    );
    expect(list.status).toBe(200);
    expect(mocks.listRelationships).toHaveBeenCalledWith('tenant-a', {
      relationshipType: 'manager',
      limit: 10,
      offset: 2,
    });

    mocks.getRelationship.mockResolvedValue(relationship({ tenant_id: 'tenant-b' }));
    expect(
      (
        await request(
          '/api/admin/admin-relationships/relationship-b',
          'GET',
          undefined,
          readHeaders
        )
      ).status
    ).toBe(404);

    mocks.getRelationship.mockResolvedValue(null);
    expect(
      (await request('/api/admin/admin-relationships/missing', 'GET', undefined, readHeaders))
        .status
    ).toBe(404);
  });

  it('validates relationship creation and uses the authenticated actor', async () => {
    expect((await request('/api/admin/admin-relationships', 'POST', {})).status).toBe(400);
    mocks.hasRelationship.mockResolvedValue(true);
    expect(
      (
        await request('/api/admin/admin-relationships', 'POST', {
          relationship_type: 'manager',
          from_id: 'admin-a',
          to_id: 'resource-a',
        })
      ).status
    ).toBe(409);

    mocks.hasRelationship.mockResolvedValue(false);
    mocks.createRelationship.mockResolvedValue(relationship());
    const response = await request('/api/admin/admin-relationships', 'POST', {
      relationship_type: 'manager',
      from_id: 'admin-a',
      to_id: 'resource-a',
      tenant_id: 'tenant-b',
      created_by: 'attacker',
    });
    expect(response.status).toBe(201);
    expect(mocks.createRelationship).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-a', created_by: 'actor-a' })
    );
  });

  it('does not delete a relationship from another tenant', async () => {
    mocks.getRelationship.mockResolvedValue(relationship({ tenant_id: 'tenant-b' }));
    expect((await request('/api/admin/admin-relationships/relationship-a', 'DELETE')).status).toBe(
      404
    );
    expect(mocks.deleteRelationship).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('does not audit a relationship that disappeared before deletion', async () => {
    mocks.getRelationship.mockResolvedValueOnce(null);
    expect((await request('/api/admin/admin-relationships/missing', 'DELETE')).status).toBe(404);

    mocks.getRelationship.mockResolvedValue(relationship());
    mocks.deleteRelationship.mockResolvedValue(false);
    expect((await request('/api/admin/admin-relationships/relationship-a', 'DELETE')).status).toBe(
      404
    );
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('hides foreign admins and filters defensive cross-tenant rows in user relationship lists', async () => {
    mocks.findAdmin.mockResolvedValueOnce(null);
    expect(
      (await request('/api/admin/admins/admin-b/relationships', 'GET', undefined, readHeaders))
        .status
    ).toBe(404);
    expect(mocks.getRelationshipsFrom).not.toHaveBeenCalled();

    mocks.getRelationshipsFrom.mockResolvedValue([
      relationship(),
      relationship({ id: 'foreign', tenant_id: 'tenant-b' }),
    ]);
    mocks.getRelationshipsTo.mockResolvedValue([relationship()]);
    const response = await request(
      '/api/admin/admins/admin-a/relationships?direction=both',
      'GET',
      undefined,
      readHeaders
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ items: Array<{ id: string }>; total: number }>();
    expect(body).toEqual({ items: [expect.objectContaining({ id: 'relationship-a' })], total: 1 });

    mocks.getRelationshipsFrom.mockResolvedValue([relationship({ id: 'from-only' })]);
    mocks.getRelationshipsTo.mockClear();
    expect(
      (
        await request(
          '/api/admin/admins/admin-a/relationships?direction=from',
          'GET',
          undefined,
          readHeaders
        )
      ).status
    ).toBe(200);
    expect(mocks.getRelationshipsTo).not.toHaveBeenCalled();

    mocks.getRelationshipsFrom.mockClear();
    mocks.getRelationshipsTo.mockResolvedValue([relationship({ id: 'to-only', to_id: 'admin-a' })]);
    expect(
      (
        await request(
          '/api/admin/admins/admin-a/relationships?direction=to',
          'GET',
          undefined,
          readHeaders
        )
      ).status
    ).toBe(200);
    expect(mocks.getRelationshipsFrom).not.toHaveBeenCalled();
  });

  it('creates user relationships only for an admin in the current tenant', async () => {
    mocks.findAdmin.mockResolvedValueOnce(null);
    expect(
      (
        await request('/api/admin/admins/admin-b/relationships', 'POST', {
          relationship_type: 'manager',
          to_id: 'resource-a',
        })
      ).status
    ).toBe(404);
    expect(mocks.hasRelationship).not.toHaveBeenCalled();

    mocks.hasRelationship.mockResolvedValue(false);
    mocks.createRelationship.mockResolvedValue(relationship());
    expect(
      (
        await request('/api/admin/admins/admin-a/relationships', 'POST', {
          relationship_type: 'manager',
          to_id: 'resource-a',
        })
      ).status
    ).toBe(201);
    expect(mocks.createRelationship).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-a', from_id: 'admin-a', created_by: 'actor-a' })
    );
  });

  it('requires complete, non-duplicate user relationship input', async () => {
    expect((await request('/api/admin/admins/admin-a/relationships', 'POST', {})).status).toBe(400);

    mocks.hasRelationship.mockResolvedValue(true);
    expect(
      (
        await request('/api/admin/admins/admin-a/relationships', 'POST', {
          relationship_type: 'manager',
          to_id: 'resource-a',
        })
      ).status
    ).toBe(409);
    expect(mocks.createRelationship).not.toHaveBeenCalled();
  });

  it('requires a user-path relationship to involve that current-tenant user', async () => {
    mocks.getRelationship.mockResolvedValue(
      relationship({ from_id: 'admin-other', to_id: 'resource-a' })
    );
    expect(
      (await request('/api/admin/admins/admin-a/relationships/relationship-a', 'DELETE')).status
    ).toBe(404);
    expect(mocks.deleteRelationship).not.toHaveBeenCalled();

    mocks.getRelationship.mockResolvedValue(relationship());
    mocks.deleteRelationship.mockResolvedValue(true);
    expect(
      (await request('/api/admin/admins/admin-a/relationships/relationship-a', 'DELETE')).status
    ).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'admin_relationship.delete' })
    );
  });

  it('rejects missing, foreign and raced user-path relationships without mutation', async () => {
    mocks.getRelationship.mockResolvedValueOnce(null);
    expect(
      (await request('/api/admin/admins/admin-a/relationships/missing', 'DELETE')).status
    ).toBe(404);

    mocks.getRelationship.mockResolvedValueOnce(
      relationship({ tenant_id: 'tenant-b', from_id: 'admin-a' })
    );
    expect(
      (await request('/api/admin/admins/admin-a/relationships/foreign', 'DELETE')).status
    ).toBe(404);

    mocks.getRelationship.mockResolvedValue(relationship());
    mocks.deleteRelationship.mockResolvedValue(false);
    expect(
      (await request('/api/admin/admins/admin-a/relationships/relationship-a', 'DELETE')).status
    ).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('fails closed without a success audit on repository failure', async () => {
    mocks.listRelationships.mockRejectedValue(new Error('database unavailable'));
    const response = await request('/api/admin/admin-relationships', 'GET', undefined, readHeaders);
    expect(response.status).toBe(500);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
