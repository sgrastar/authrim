import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  getAllEntries: vi.fn(),
  getEnabledEntries: vi.fn(),
  getEntry: vi.fn(),
  entryExists: vi.fn(),
  isIpAllowed: vi.fn(),
  createEntry: vi.fn(),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
  enableEntry: vi.fn(),
  disableEntry: vi.fn(),
  countEntries: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();

  class IpRepository {
    getAllEntries = mocks.getAllEntries;
    getEnabledEntries = mocks.getEnabledEntries;
    getEntry = mocks.getEntry;
    entryExists = mocks.entryExists;
    isIpAllowed = mocks.isIpAllowed;
    createEntry = mocks.createEntry;
    updateEntry = mocks.updateEntry;
    deleteEntry = mocks.deleteEntry;
    enableEntry = mocks.enableEntry;
    disableEntry = mocks.disableEntry;
    countEntries = mocks.countEntries;
  }

  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_CONFLICT]: 409,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };

  return {
    ...actual,
    AdminIpAllowlistRepository: IpRepository,
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
    createErrorResponse: (
      c: { json: (body: unknown, status?: number) => Response },
      code: string
    ) => c.json({ error_code: code }, statusByCode[code] ?? 500),
  };
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.audit }));

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { ipAllowlistRouter } from '../routes/admin-management/ip-allowlist';

const readHeaders = { 'x-test-permissions': ADMIN_PERMISSIONS.IP_ALLOWLIST_READ };
const writeHeaders = {
  'Content-Type': 'application/json',
  'x-test-permissions': `${ADMIN_PERMISSIONS.IP_ALLOWLIST_READ},${ADMIN_PERMISSIONS.IP_ALLOWLIST_WRITE}`,
};

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ip-a',
    tenant_id: 'tenant-a',
    ip_range: '192.0.2.1',
    ip_version: 4,
    enabled: true,
    ...overrides,
  };
}

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.route('/api/admin/ip-allowlist', ipAllowlistRouter);
  return instance;
}

async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = writeHeaders
) {
  const suffix = path === '/' ? '' : path.startsWith('/?') ? path.slice(1) : path;
  return app().request(
    `/api/admin/ip-allowlist${suffix}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { DB_ADMIN: {} } as never
  );
}

describe('IP allowlist security boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnabledEntries.mockResolvedValue([]);
    mocks.getAllEntries.mockResolvedValue([]);
    mocks.getEntry.mockResolvedValue(entry());
    mocks.entryExists.mockResolvedValue(false);
    mocks.isIpAllowed.mockResolvedValue(true);
    mocks.countEntries.mockResolvedValue(1);
  });

  it('lists tenant entries and reports the trusted client-IP header', async () => {
    mocks.getEnabledEntries.mockResolvedValue([entry()]);
    const enabled = await request('/', 'GET', undefined, {
      ...readHeaders,
      'cf-connecting-ip': '192.0.2.20',
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      total: 1,
      current_ip: '192.0.2.20',
      restriction_active: true,
    });
    expect(mocks.getEnabledEntries).toHaveBeenCalledWith('tenant-a');

    mocks.getAllEntries.mockResolvedValue([entry({ enabled: false })]);
    const all = await request('/?include_disabled=true', 'GET', undefined, readHeaders);
    expect(all.status).toBe(200);
    expect(mocks.getAllEntries).toHaveBeenCalledWith('tenant-a');
  });

  it('hides an ID-addressed entry from another tenant', async () => {
    mocks.getEntry.mockResolvedValue(entry({ tenant_id: 'tenant-b' }));
    const response = await request('/ip-b', 'GET', undefined, readHeaders);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error_code: AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND,
    });
  });

  it.each([
    ['POST', '/', { ip_range: '192.0.2.1' }],
    ['PATCH', '/ip-a', { description: 'office' }],
    ['DELETE', '/ip-a', undefined],
    ['POST', '/ip-a/enable', undefined],
    ['POST', '/ip-a/disable', undefined],
  ])(
    'denies %s %s without write permission and performs no mutation',
    async (method, path, body) => {
      const response = await request(path, method, body, {
        'Content-Type': 'application/json',
        ...readHeaders,
      });
      expect(response.status).toBe(403);
      expect(mocks.createEntry).not.toHaveBeenCalled();
      expect(mocks.updateEntry).not.toHaveBeenCalled();
      expect(mocks.deleteEntry).not.toHaveBeenCalled();
      expect(mocks.enableEntry).not.toHaveBeenCalled();
      expect(mocks.disableEntry).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    }
  );

  it.each([
    [undefined],
    [''],
    ['192.0.2'],
    ['256.0.0.1'],
    ['01.2.3.4'],
    ['192.0.2.1/33'],
    ['2001:db8::1/129'],
    ['2001::db8::1'],
    ['2001:db8:invalid::1'],
    ['2001:db8:0:0:0:0:0'],
  ])('rejects malformed IP range %s before accessing storage', async (ipRange) => {
    const response = await request('/', 'POST', { ip_range: ipRange });
    expect(response.status).toBe(400);
    expect(mocks.entryExists).not.toHaveBeenCalled();
    expect(mocks.createEntry).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('rejects duplicate ranges without mutation', async () => {
    mocks.entryExists.mockResolvedValue(true);
    expect((await request('/', 'POST', { ip_range: ' 192.0.2.1 ' })).status).toBe(409);
    expect(mocks.entryExists).toHaveBeenCalledWith('tenant-a', '192.0.2.1');
    expect(mocks.createEntry).not.toHaveBeenCalled();
  });

  it.each([
    ['192.0.2.0/24', 4],
    ['2001:db8::1', 6],
    ['2001:db8::/64', 6],
    ['2001:db8:0:0:0:0:0:1', 6],
  ])(
    'creates a normalized %s entry as IPv%s and writes a security audit',
    async (ipRange, version) => {
      mocks.createEntry.mockResolvedValue(entry({ ip_range: ipRange, ip_version: version }));
      const response = await request('/', 'POST', {
        ip_range: ` ${ipRange} `,
        description: 'office',
        enabled: false,
        tenant_id: 'tenant-b',
        created_by: 'attacker',
      });
      expect(response.status).toBe(201);
      expect(mocks.createEntry).toHaveBeenCalledWith({
        tenant_id: 'tenant-a',
        ip_range: ipRange,
        ip_version: version,
        description: 'office',
        enabled: false,
        created_by: 'actor-a',
      });
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'ip_allowlist.create',
          severity: 'warn',
        })
      );
    }
  );

  it('does not update an entry from another tenant', async () => {
    mocks.getEntry.mockResolvedValue(entry({ tenant_id: 'tenant-b' }));
    expect((await request('/ip-b', 'PATCH', { description: 'hijacked' })).status).toBe(404);
    expect(mocks.updateEntry).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('validates an updated range and audits only a persisted update', async () => {
    expect((await request('/ip-a', 'PATCH', { ip_range: '999.0.0.1' })).status).toBe(400);
    expect(mocks.updateEntry).not.toHaveBeenCalled();

    mocks.updateEntry.mockResolvedValue(null);
    expect((await request('/ip-a', 'PATCH', { description: 'raced' })).status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();

    mocks.updateEntry.mockResolvedValue(entry({ ip_range: '2001:db8::/64', ip_version: 6 }));
    const response = await request('/ip-a', 'PATCH', {
      ip_range: ' 2001:db8::/64 ',
      enabled: false,
    });
    expect(response.status).toBe(200);
    expect(mocks.updateEntry).toHaveBeenCalledWith('ip-a', {
      ip_range: '2001:db8::/64',
      ip_version: 6,
      description: undefined,
      enabled: false,
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ip_allowlist.update' })
    );
  });

  it('deletes only a current-tenant entry and audits after deletion', async () => {
    mocks.getEntry.mockResolvedValueOnce(null);
    expect((await request('/missing', 'DELETE')).status).toBe(404);

    mocks.getEntry.mockResolvedValueOnce(entry({ tenant_id: 'tenant-b' }));
    expect((await request('/foreign', 'DELETE')).status).toBe(404);
    expect(mocks.deleteEntry).not.toHaveBeenCalled();

    mocks.getEntry.mockResolvedValue(entry());
    expect((await request('/ip-a', 'DELETE')).status).toBe(200);
    expect(mocks.deleteEntry).toHaveBeenCalledWith('ip-a');
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ip_allowlist.delete' })
    );
  });

  it.each([
    ['enable', 'enableEntry'],
    ['disable', 'disableEntry'],
  ] as const)('protects tenant ownership and persistence for %s', async (action, method) => {
    mocks.getEntry.mockResolvedValueOnce(entry({ tenant_id: 'tenant-b' }));
    expect((await request(`/ip-b/${action}`, 'POST')).status).toBe(404);
    expect(mocks[method]).not.toHaveBeenCalled();

    mocks.getEntry.mockResolvedValue(entry());
    mocks[method].mockResolvedValueOnce(false);
    expect((await request(`/ip-a/${action}`, 'POST')).status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();

    mocks[method].mockResolvedValue(true);
    expect((await request(`/ip-a/${action}`, 'POST')).status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: `ip_allowlist.${action}` })
    );
  });

  it('checks an IP using only the current tenant and exposes restriction state', async () => {
    expect((await request('/check', 'POST', {})).status).toBe(400);

    mocks.isIpAllowed.mockResolvedValue(false);
    mocks.countEntries.mockResolvedValue(2);
    const response = await request('/check', 'POST', { ip: '198.51.100.20' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ip: '198.51.100.20',
      allowed: false,
      restriction_active: true,
      entry_count: 2,
    });
    expect(mocks.isIpAllowed).toHaveBeenCalledWith('tenant-a', '198.51.100.20');
    expect(mocks.countEntries).toHaveBeenCalledWith('tenant-a');
  });

  it('fails closed and does not audit when storage fails', async () => {
    mocks.createEntry.mockRejectedValue(new Error('database unavailable'));
    // The caller is the address being added, so the lock-out guard lets the write be tried.
    const response = await request(
      '/',
      'POST',
      { ip_range: '192.0.2.1' },
      {
        ...writeHeaders,
        'cf-connecting-ip': '192.0.2.1',
      }
    );
    expect(response.status).toBe(500);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('IP allowlist lock-out guard and list state', () => {
  const me = '203.0.113.5';
  const asMe = { ...writeHeaders, 'cf-connecting-ip': me };
  const covering = entry({ id: 'a', ip_range: '203.0.113.0/24' });
  const elsewhere = entry({ id: 'b', ip_range: '198.51.100.0/24' });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAllEntries.mockResolvedValue([]);
    mocks.getEnabledEntries.mockResolvedValue([]);
    mocks.getEntry.mockResolvedValue(covering);
    mocks.entryExists.mockResolvedValue(false);
    mocks.createEntry.mockResolvedValue(entry({ id: 'n' }));
    mocks.updateEntry.mockImplementation(async (id: string) => entry({ id }));
    mocks.deleteEntry.mockResolvedValue(true);
    mocks.enableEntry.mockResolvedValue(true);
    mocks.disableEntry.mockResolvedValue(true);
  });

  it('says the limit is off when only disabled entries are listed, and names the address it judges by', async () => {
    mocks.getAllEntries.mockResolvedValue([entry({ enabled: false })]);
    const response = await request('/?include_disabled=true', 'GET', undefined, {
      ...readHeaders,
      'x-forwarded-for': '203.0.113.5, 10.0.0.1',
    });
    await expect(response.json()).resolves.toMatchObject({
      restriction_active: false,
      current_ip: '203.0.113.5',
      total: 1,
    });
  });

  it('refuses a first entry that leaves the caller outside, unless asked to go on', async () => {
    const refused = await request('/', 'POST', { ip_range: '198.51.100.0/24' }, asMe);
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: 'would_lock_out',
      current_ip: me,
    });
    expect(mocks.createEntry).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();

    const allowed = await request(
      '/?allow_lockout=true',
      'POST',
      { ip_range: '198.51.100.0/24' },
      asMe
    );
    expect(allowed.status).toBe(201);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ip_allowlist.create',
        metadata: expect.objectContaining({ lockout_override: true }),
      })
    );
  });

  it('lets in an entry that covers the caller, or one that is not enabled', async () => {
    expect((await request('/', 'POST', { ip_range: '203.0.113.0/24' }, asMe)).status).toBe(201);
    expect(
      (await request('/', 'POST', { ip_range: '198.51.100.0/24', enabled: false }, asMe)).status
    ).toBe(201);
  });

  it('refuses switching off, deleting or editing away the last range that covers the caller', async () => {
    mocks.getAllEntries.mockResolvedValue([covering, elsewhere]);
    expect((await request('/a/disable', 'POST', {}, asMe)).status).toBe(409);
    expect((await request('/a', 'DELETE', undefined, asMe)).status).toBe(409);
    expect((await request('/a', 'PATCH', { ip_range: '192.0.2.0/24' }, asMe)).status).toBe(409);
    expect((await request('/a', 'PATCH', { enabled: false }, asMe)).status).toBe(409);
    expect(mocks.disableEntry).not.toHaveBeenCalled();
    expect(mocks.deleteEntry).not.toHaveBeenCalled();
    expect(mocks.updateEntry).not.toHaveBeenCalled();

    expect((await request('/a/disable?allow_lockout=true', 'POST', {}, asMe)).status).toBe(200);
    expect(mocks.disableEntry).toHaveBeenCalledWith('a');
  });

  it('refuses enabling an entry that starts a limit the caller is outside of', async () => {
    mocks.getAllEntries.mockResolvedValue([{ ...elsewhere, enabled: false }]);
    mocks.getEntry.mockResolvedValue({ ...elsewhere, enabled: false });
    expect((await request('/b/enable', 'POST', {}, asMe)).status).toBe(409);
    expect(mocks.enableEntry).not.toHaveBeenCalled();
  });

  it('does not hold a change that leaves the caller inside, lifts the limit, or only edits text', async () => {
    mocks.getAllEntries.mockResolvedValue([covering, elsewhere]);
    mocks.getEntry.mockResolvedValue(elsewhere);
    expect((await request('/b/disable', 'POST', {}, asMe)).status).toBe(200);
    expect((await request('/b', 'DELETE', undefined, asMe)).status).toBe(200);
    expect((await request('/b', 'PATCH', { description: 'branch' }, asMe)).status).toBe(200);

    mocks.getAllEntries.mockResolvedValue([covering]);
    mocks.getEntry.mockResolvedValue(covering);
    // Deleting the only entry takes the limit off: the caller is not shut out.
    expect((await request('/a', 'DELETE', undefined, asMe)).status).toBe(200);
  });

  it('does not blame a change for a limit the caller was outside of already', async () => {
    mocks.getAllEntries.mockResolvedValue([elsewhere]);
    expect((await request('/', 'POST', { ip_range: '192.0.2.0/24' }, asMe)).status).toBe(201);
  });

  it('holds a first entry when the caller has no address to judge by, since the next request would be refused', async () => {
    expect((await request('/', 'POST', { ip_range: '198.51.100.0/24' })).status).toBe(409);
    expect(mocks.createEntry).not.toHaveBeenCalled();
    // With a limit already on, no address is outside it already: this change is not what does it.
    mocks.getAllEntries.mockResolvedValue([elsewhere]);
    expect((await request('/', 'POST', { ip_range: '192.0.2.0/24' })).status).toBe(201);
  });

  it('refuses what it would store differently from what the guard judged', async () => {
    mocks.getAllEntries.mockResolvedValue([covering, elsewhere]);
    expect((await request('/a', 'PATCH', { ip_range: '' }, asMe)).status).toBe(400);
    expect((await request('/a', 'PATCH', { ip_range: '   ' }, asMe)).status).toBe(400);
    expect((await request('/a', 'PATCH', { ip_range: 5 }, asMe)).status).toBe(400);
    expect((await request('/a', 'PATCH', { enabled: null }, asMe)).status).toBe(400);
    expect((await request('/a', 'PATCH', { enabled: 'false' }, asMe)).status).toBe(400);
    expect(
      (await request('/', 'POST', { ip_range: '203.0.113.0/24', enabled: 'false' }, asMe)).status
    ).toBe(400);
    expect((await request('/', 'POST', { ip_range: 7 }, asMe)).status).toBe(400);
    expect(mocks.updateEntry).not.toHaveBeenCalled();
    expect(mocks.createEntry).not.toHaveBeenCalled();
  });

  it('refuses to move an entry onto a range another entry has, but not to keep its own', async () => {
    mocks.entryExists.mockResolvedValue(true);
    mocks.getAllEntries.mockResolvedValue([covering]);
    expect((await request('/a', 'PATCH', { ip_range: '198.51.100.0/24' }, asMe)).status).toBe(409);
    expect(mocks.entryExists).toHaveBeenCalledWith('tenant-a', '198.51.100.0/24');
    expect(mocks.updateEntry).not.toHaveBeenCalled();

    mocks.entryExists.mockClear();
    expect(
      (await request('/a', 'PATCH', { ip_range: '203.0.113.0/24', description: 'x' }, asMe)).status
    ).toBe(200);
    expect(mocks.entryExists).not.toHaveBeenCalled();
  });
});
