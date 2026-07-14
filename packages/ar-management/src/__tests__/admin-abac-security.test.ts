import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  listAttributes: vi.fn(),
  getAttribute: vi.fn(),
  getAttributeByName: vi.fn(),
  createAttribute: vi.fn(),
  updateAttribute: vi.fn(),
  deleteAttribute: vi.fn(),
  deleteAllByAttribute: vi.fn(),
  getAttributesByUser: vi.fn(),
  setAttributeValue: vi.fn(),
  deleteAttributeValue: vi.fn(),
  findAdmin: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();

  class AttributeRepository {
    listAttributes = mocks.listAttributes;
    getAttribute = mocks.getAttribute;
    getAttributeByName = mocks.getAttributeByName;
    createAttribute = mocks.createAttribute;
    updateAttribute = mocks.updateAttribute;
    deleteAttribute = mocks.deleteAttribute;
  }

  class AttributeValueRepository {
    deleteAllByAttribute = mocks.deleteAllByAttribute;
    getAttributesByUser = mocks.getAttributesByUser;
    setAttributeValue = mocks.setAttributeValue;
    deleteAttributeValue = mocks.deleteAttributeValue;
  }

  class UserRepository {
    findByTenantAndId = mocks.findAdmin;
  }

  return {
    ...actual,
    AdminAttributeRepository: AttributeRepository,
    AdminAttributeValueRepository: AttributeValueRepository,
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
import { adminAbacRouter } from '../routes/admin-management/admin-abac';

const readHeaders = { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_READ };
const writeHeaders = {
  'Content-Type': 'application/json',
  'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_READ},${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE}`,
};

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.route('/api/admin', adminAbacRouter);
  return instance;
}

function attribute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'attr-a',
    tenant_id: 'tenant-a',
    name: 'department',
    is_system: false,
    ...overrides,
  };
}

async function jsonRequest(
  path: string,
  method: string,
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

describe('admin ABAC security boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAdmin.mockResolvedValue({ id: 'admin-a', tenant_id: 'tenant-a' });
    mocks.getAttribute.mockResolvedValue(attribute());
  });

  it('lists and reads only attributes visible to the current tenant', async () => {
    mocks.listAttributes.mockResolvedValue([attribute()]);
    const list = await app().request(
      '/api/admin/admin-attributes?include_system=true&limit=20&offset=2',
      { headers: readHeaders },
      { DB_ADMIN: {} } as never
    );
    expect(list.status).toBe(200);
    expect(mocks.listAttributes).toHaveBeenCalledWith('tenant-a', {
      includeSystem: true,
      limit: 20,
      offset: 2,
    });

    mocks.getAttribute.mockResolvedValue(attribute({ tenant_id: 'tenant-b' }));
    expect(
      (
        await app().request('/api/admin/admin-attributes/attr-b', { headers: readHeaders }, {
          DB_ADMIN: {},
        } as never)
      ).status
    ).toBe(404);

    mocks.getAttribute.mockResolvedValue(attribute({ tenant_id: 'system', is_system: true }));
    expect(
      (
        await app().request('/api/admin/admin-attributes/system', { headers: readHeaders }, {
          DB_ADMIN: {},
        } as never)
      ).status
    ).toBe(200);
  });

  it.each([
    ['POST', '/api/admin/admin-attributes', { name: 'department' }],
    ['PATCH', '/api/admin/admin-attributes/attr-a', { display_name: 'Department' }],
    ['DELETE', '/api/admin/admin-attributes/attr-a', undefined],
    ['PUT', '/api/admin/admins/admin-a/attributes/attr-a', { value: 'security' }],
    ['DELETE', '/api/admin/admins/admin-a/attributes/attr-a', undefined],
  ])(
    'denies %s %s without write permission and performs no mutation',
    async (method, path, body) => {
      const response = await jsonRequest(path, method, body, {
        'Content-Type': 'application/json',
        ...readHeaders,
      });
      expect(response.status).toBe(403);
      expect(mocks.createAttribute).not.toHaveBeenCalled();
      expect(mocks.updateAttribute).not.toHaveBeenCalled();
      expect(mocks.deleteAttribute).not.toHaveBeenCalled();
      expect(mocks.setAttributeValue).not.toHaveBeenCalled();
      expect(mocks.deleteAttributeValue).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    }
  );

  it('validates creation, prevents duplicates and ignores mass-assignment fields', async () => {
    expect((await jsonRequest('/api/admin/admin-attributes', 'POST', {})).status).toBe(400);

    mocks.getAttributeByName.mockResolvedValue(attribute());
    expect(
      (await jsonRequest('/api/admin/admin-attributes', 'POST', { name: 'department' })).status
    ).toBe(409);

    mocks.getAttributeByName.mockResolvedValue(null);
    mocks.createAttribute.mockResolvedValue(attribute());
    const response = await jsonRequest('/api/admin/admin-attributes', 'POST', {
      name: 'department',
      display_name: 'Department',
      tenant_id: 'tenant-b',
      is_system: true,
    });
    expect(response.status).toBe(201);
    expect(mocks.createAttribute).toHaveBeenCalledWith({
      tenant_id: 'tenant-a',
      name: 'department',
      display_name: 'Department',
      description: undefined,
      attribute_type: undefined,
      allowed_values: undefined,
      min_value: undefined,
      max_value: undefined,
      regex_pattern: undefined,
      is_required: undefined,
      is_multi_valued: undefined,
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'admin_attribute.create', resourceId: 'attr-a' })
    );
  });

  it('does not update or delete attributes across tenant boundaries', async () => {
    mocks.getAttribute.mockResolvedValue(attribute({ tenant_id: 'tenant-b' }));
    expect(
      (
        await jsonRequest('/api/admin/admin-attributes/attr-a', 'PATCH', {
          display_name: 'stolen',
        })
      ).status
    ).toBe(404);
    expect((await jsonRequest('/api/admin/admin-attributes/attr-a', 'DELETE')).status).toBe(404);
    expect(mocks.updateAttribute).not.toHaveBeenCalled();
    expect(mocks.deleteAllByAttribute).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('returns not-found without auditing when an attribute disappears during mutation', async () => {
    mocks.getAttribute.mockResolvedValueOnce(null);
    expect(
      (
        await app().request('/api/admin/admin-attributes/missing', { headers: readHeaders }, {
          DB_ADMIN: {},
        } as never)
      ).status
    ).toBe(404);

    mocks.getAttribute.mockResolvedValue(attribute());
    mocks.updateAttribute.mockResolvedValue(null);
    expect(
      (
        await jsonRequest('/api/admin/admin-attributes/attr-a', 'PATCH', {
          display_name: 'Department',
        })
      ).status
    ).toBe(404);

    mocks.deleteAttribute.mockResolvedValue(false);
    expect((await jsonRequest('/api/admin/admin-attributes/attr-a', 'DELETE')).status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('updates and deletes a tenant attribute with auditable side effects', async () => {
    mocks.updateAttribute.mockResolvedValue(attribute({ display_name: 'Department' }));
    expect(
      (
        await jsonRequest('/api/admin/admin-attributes/attr-a', 'PATCH', {
          display_name: 'Department',
        })
      ).status
    ).toBe(200);
    expect(mocks.updateAttribute).toHaveBeenCalledWith(
      'attr-a',
      expect.objectContaining({ display_name: 'Department' })
    );

    mocks.deleteAttribute.mockResolvedValue(true);
    expect((await jsonRequest('/api/admin/admin-attributes/attr-a', 'DELETE')).status).toBe(200);
    expect(mocks.deleteAllByAttribute).toHaveBeenCalledWith('attr-a');
    expect(mocks.deleteAttribute).toHaveBeenCalledWith('attr-a');
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'admin_attribute.delete' })
    );
  });

  it.each([
    ['GET', '/api/admin/admins/admin-b/attributes', undefined],
    ['PUT', '/api/admin/admins/admin-b/attributes/attr-a', { value: 'security' }],
    ['DELETE', '/api/admin/admins/admin-b/attributes/attr-a', undefined],
  ])(
    'hides another tenant admin for %s %s without reading or changing attributes',
    async (method, path, body) => {
      mocks.findAdmin.mockResolvedValue(null);
      const response = await jsonRequest(path, method, body);
      expect(response.status).toBe(404);
      expect(mocks.getAttributesByUser).not.toHaveBeenCalled();
      expect(mocks.setAttributeValue).not.toHaveBeenCalled();
      expect(mocks.deleteAttributeValue).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    }
  );

  it('sets a value only for a current-tenant admin and attribute', async () => {
    expect(
      (await jsonRequest('/api/admin/admins/admin-a/attributes/attr-a', 'PUT', {})).status
    ).toBe(400);

    mocks.getAttribute.mockResolvedValue(attribute({ tenant_id: 'tenant-b' }));
    expect(
      (
        await jsonRequest('/api/admin/admins/admin-a/attributes/attr-a', 'PUT', {
          value: 'security',
        })
      ).status
    ).toBe(404);

    mocks.getAttribute.mockResolvedValue(attribute());
    mocks.setAttributeValue.mockResolvedValue({ id: 'value-a', value: 'security' });
    const response = await jsonRequest('/api/admin/admins/admin-a/attributes/attr-a', 'PUT', {
      value: 'security',
      value_index: 1,
      assigned_by: 'attacker',
    });
    expect(response.status).toBe(200);
    expect(mocks.setAttributeValue).toHaveBeenCalledWith({
      tenant_id: 'tenant-a',
      admin_user_id: 'admin-a',
      admin_attribute_id: 'attr-a',
      value: 'security',
      value_index: 1,
      expires_at: undefined,
      assigned_by: 'actor-a',
    });
  });

  it('lists and deletes values with tenant checks and observable results', async () => {
    mocks.getAttributesByUser.mockResolvedValue([{ id: 'value-a' }]);
    const list = await jsonRequest(
      '/api/admin/admins/admin-a/attributes',
      'GET',
      undefined,
      readHeaders
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ total: 1 });

    mocks.deleteAttributeValue.mockResolvedValue(false);
    expect(
      (await jsonRequest('/api/admin/admins/admin-a/attributes/attr-a?value_index=2', 'DELETE'))
        .status
    ).toBe(404);

    mocks.deleteAttributeValue.mockResolvedValue(true);
    expect(
      (await jsonRequest('/api/admin/admins/admin-a/attributes/attr-a?value_index=2', 'DELETE'))
        .status
    ).toBe(200);
    expect(mocks.deleteAttributeValue).toHaveBeenLastCalledWith('admin-a', 'attr-a', 2);
  });

  it('fails closed and emits no success audit when storage fails', async () => {
    mocks.createAttribute.mockRejectedValue(new Error('database unavailable'));
    mocks.getAttributeByName.mockResolvedValue(null);
    const response = await jsonRequest('/api/admin/admin-attributes', 'POST', {
      name: 'department',
    });
    expect(response.status).toBe(500);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
